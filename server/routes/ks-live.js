import express from 'express'
import * as db from '../../lib/db.js'
import { syncFillsForBettor } from '../../lib/ksFillSync.js'
import { todayISO, roundTo, userFilter, wrap } from '../shared.js'
import { getLastFillEventAt } from '../sse.js'

let mlbFetch, extractStarterFromBoxscore
try {
  const mlbLive = await import('../../lib/mlb-live.js')
  mlbFetch                = mlbLive.mlbFetch
  extractStarterFromBoxscore = mlbLive.extractStarterFromBoxscore
} catch { /* live polling gracefully degrades */ }

const router = express.Router()

router.get('/ks/live', wrap(async (req, res) => {
  const date = req.query.date || todayISO()
  const uf   = userFilter(req)

  // Sync fills only if WS daemon hasn't pushed a fill event in the last 60s
  const lastFill = getLastFillEventAt()
  if (uf.userId && (!lastFill || Date.now() - lastFill > 60_000)) {
    const u = await db.one(`SELECT id, kalshi_key_id, kalshi_private_key FROM users WHERE id = ?`, [uf.userId])
    if (u) syncFillsForBettor(u).catch(() => {})
  }

  const allBets = await db.all(
    `SELECT id, pitcher_id, pitcher_name, strike, side, market_mid, spread, bet_size,
            filled_contracts, fill_price, order_status, result
       FROM ks_bets
       WHERE bet_date = ? AND live_bet = 0
         AND (order_id IS NOT NULL OR filled_contracts > 0 OR result IS NOT NULL)
         ${uf.clause}`,
    [date, ...uf.args],
  )
  if (!allBets.length) return res.json({ date, has_live: false, pitchers: [] })
  const pending    = allBets.filter(b => !b.result)
  const pitcherIds = new Set(allBets.map(b => String(b.pitcher_id)).filter(Boolean))

  const sched = await mlbFetch(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,probablePitcher`,
  )
  const games   = sched?.dates?.[0]?.games || []
  const results = []

  const gamesToFetch = games.filter(g => {
    const status = g.status?.abstractGameState
    if (status === 'Preview') {
      const awayProb = String(g.teams?.away?.probablePitcher?.id || '')
      const homeProb = String(g.teams?.home?.probablePitcher?.id || '')
      return pitcherIds.has(awayProb) || pitcherIds.has(homeProb)
    }
    return true
  })

  const boxscores = await Promise.all(
    gamesToFetch.map(g => mlbFetch(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`))
  )

  for (let gi = 0; gi < gamesToFetch.length; gi++) {
    const g  = gamesToFetch[gi]
    const bs = boxscores[gi]
    if (!bs) continue

    const status  = g.status?.abstractGameState
    const ls      = g.linescore
    const isFinal = status === 'Final'
    const detail  = g.status?.detailedState || status
    const inning  = isFinal ? 'Final' : (ls?.currentInningOrdinal || detail)
    const away    = g.teams?.away?.team?.abbreviation || 'AWAY'
    const home    = g.teams?.home?.team?.abbreviation || 'HOME'
    const gamePk  = g.gamePk

    for (const side of ['home', 'away']) {
      const starter = extractStarterFromBoxscore(bs, side)
      if (!starter || !pitcherIds.has(starter.id)) continue

      const myBets    = pending.filter(b => String(b.pitcher_id) === starter.id)
      const allMyBets = allBets.filter(b => String(b.pitcher_id) === starter.id)

      if (!isFinal) {
        const wrongLosses = allMyBets.filter(b =>
          b.result === 'loss' && b.side === 'YES' && starter.ks >= b.strike
        )
        for (const b of wrongLosses) {
          const FEE       = 0.07
          const contracts = b.filled_contracts
          const fillFrac  = contracts ? (b.fill_price ?? (b.market_mid ?? 50)) / 100 : (b.market_mid ?? 50) / 100
          const size      = contracts ?? (b.bet_size ?? 100)
          const pnl       = Math.round(size * (1 - fillFrac) * (1 - FEE) * 100) / 100
          await db.run(
            `UPDATE ks_bets SET result='win', actual_ks=?, pnl=?, settled_at=? WHERE id=?`,
            [starter.ks, pnl, new Date().toISOString(), b.id],
          )
          console.log(`[live] corrected wrong loss → WIN: ${b.pitcher_name} YES ${b.strike}+ (${starter.ks}K)  +$${pnl}`)
        }
      }

      const betsToSettle = myBets.filter(b => {
        if (b.side === 'YES' && starter.ks >= b.strike) return true
        if (isFinal) return true
        return false
      })
      if (betsToSettle.length) {
        const FEE = 0.07
        const now = new Date().toISOString()
        for (const b of betsToSettle) {
          const won       = b.side === 'YES' ? starter.ks >= b.strike : starter.ks < b.strike
          const mid       = (b.market_mid ?? 50) / 100
          const hs        = (b.spread ?? 4) / 200
          const fill      = b.side === 'YES' ? mid + hs : (1 - mid) + hs
          const contracts = b.filled_contracts
          const fillFrac  = contracts ? (b.fill_price ?? (b.market_mid ?? 50)) / 100 : fill
          const size      = contracts ?? (b.bet_size ?? 100)
          const pnl       = won
            ? size * (1 - fillFrac) * (1 - FEE)
            : -(size * fillFrac)
          await db.run(
            `UPDATE ks_bets SET actual_ks=?, result=?, settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
            [starter.ks, won ? 'win' : 'loss', now, roundTo(pnl, 2), b.id],
          )
        }
      }

      results.push({
        pitcher_id:   starter.id,
        pitcher_name: starter.name,
        ks:           starter.ks,
        ip:           parseFloat(starter.ip.toFixed(1)),
        bf:           starter.bf,
        pitches:      starter.pitches,
        still_in:     starter.still_in,
        tto3:         starter.bf >= 18,
        game:         `${away}@${home}`,
        gamePk,
        game_status:  detail,
        inning,
        is_final:     isFinal,
        home_score:   ls?.teams?.home?.runs ?? null,
        away_score:   ls?.teams?.away?.runs ?? null,
        bet_statuses: allMyBets.map(b => ({
          id:     b.id,
          strike: b.strike,
          side:   b.side,
          result: b.result ?? null,
          ks:     starter.ks,
          needed: Math.max(0, b.strike - starter.ks),
        })),
      })
    }
  }

  res.json({ date, has_live: results.some(p => !p.is_final), pitchers: results })
}))

router.get('/ks/live-bets', wrap(async (req, res) => {
  const date = req.query.date && req.query.date !== 'today' ? req.query.date : todayISO()
  const uf   = userFilter(req)

  const bets = await db.all(`
    SELECT id, pitcher_name, strike, side, bet_size, market_mid, spread,
           result, pnl, logged_at,
           live_ks_at_bet, live_ip_at_bet, live_inning, live_score
    FROM ks_bets
    WHERE bet_date = ? AND live_bet = 1 ${uf.clause}
    ORDER BY pitcher_name ASC, strike ASC, logged_at DESC
  `, [date, ...uf.args])

  const bestMap = new Map()
  for (const b of bets) {
    const key = `${b.pitcher_name}|${b.strike}|${b.side}`
    if (!bestMap.has(key)) bestMap.set(key, b)
  }
  const deduped = [...bestMap.values()]

  const byPitcher = new Map()
  for (const b of deduped) {
    if (!byPitcher.has(b.pitcher_name)) byPitcher.set(b.pitcher_name, [])
    byPitcher.get(b.pitcher_name).push(b)
  }

  const pitchers = [...byPitcher.entries()].map(([name, pBets]) => ({
    pitcher_name: name,
    bets: pBets,
    wins:    pBets.filter(b => b.result === 'win').length,
    losses:  pBets.filter(b => b.result === 'loss').length,
    pending: pBets.filter(b => !b.result).length,
    pnl:     roundTo(pBets.reduce((s, b) => s + (b.pnl || 0), 0), 2),
  }))

  const totals = {
    bets:    deduped.length,
    wins:    deduped.filter(b => b.result === 'win').length,
    losses:  deduped.filter(b => b.result === 'loss').length,
    pending: deduped.filter(b => !b.result).length,
    pnl:     roundTo(deduped.reduce((s, b) => s + (b.pnl || 0), 0), 2),
  }

  res.json({ date, pitchers, totals })
}))

router.get('/ks/live-log', wrap(async (req, res) => {
  const date  = req.query.date  || todayISO()
  const limit = Math.min(parseInt(req.query.limit || '500', 10), 2000)
  const rows  = await db.getLiveLogs({ date, limit })
  res.json({ date, count: rows.length, logs: rows })
}))

export default router
