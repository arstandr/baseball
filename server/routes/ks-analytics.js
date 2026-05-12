import express from 'express'
import axios from 'axios'
import * as db from '../../lib/db.js'
import { getBalance as getKalshiBalance, getAuthHeaders } from '../../lib/kalshi.js'
import { syncFillsForBettor } from '../../lib/ksFillSync.js'
import { reconcilePositionsForBettor } from '../../lib/kalshiPositionSync.js'
import { forceSync } from '../../lib/ksSettlementSync.js'
import {
  todayISO, roundTo, userFilter, wrap, isoWeekGroup,
  STARTING_BANKROLL, _balanceCache, BALANCE_CACHE_MS, seedDailyPnlFromRest,
} from '../shared.js'
import { getLastFillEventAt } from '../sse.js'
import { getPnlFromDailyEvents, computeCurrentStreak } from '../../lib/ksMetrics.js'

const router = express.Router()

router.get('/ks/summary', wrap(async (req, res) => {
  const today    = todayISO()
  const now      = new Date()
  const yearStart = `${now.getUTCFullYear()}-01-01`
  const weekAgo   = new Date(now.getTime() - 7  * 86400000).toISOString().slice(0, 10)
  const monthAgo  = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10)

  const uf = userFilter(req)
  const [totals, pending, recentBets, liveTotals] = await Promise.all([
    db.one(`
      SELECT
        SUM(CASE WHEN bet_date = ?  AND result IN ('win','loss') THEN COALESCE(pnl,0) ELSE 0 END) AS today_pnl_fallback,
        SUM(CASE WHEN bet_date >= ? AND result IN ('win','loss') THEN COALESCE(pnl,0) ELSE 0 END) AS week_pnl_fallback,
        SUM(CASE WHEN bet_date >= ? AND result IN ('win','loss') THEN COALESCE(pnl,0) ELSE 0 END) AS month_pnl_fallback,
        SUM(CASE WHEN bet_date >= ? AND result IN ('win','loss') THEN COALESCE(pnl,0) ELSE 0 END) AS ytd_pnl_fallback,
        SUM(CASE WHEN result = 'win'  AND live_bet = 0 THEN 1 ELSE 0 END)                   AS wins,
        SUM(CASE WHEN result = 'loss' AND live_bet = 0 THEN 1 ELSE 0 END)                   AS losses,
        SUM(CASE WHEN live_bet = 0 AND result IN ('win','loss') THEN 1 ELSE 0 END)           AS settled,
        COUNT(CASE WHEN live_bet = 0 THEN 1 END)                                            AS total_bets,
        AVG(CASE WHEN live_bet = 0 AND result IN ('win','loss') THEN edge END)              AS avg_edge
      FROM ks_bets WHERE live_bet = 0 AND paper = 0 ${uf.clause}
    `, [today, weekAgo, monthAgo, yearStart, ...uf.args]),
    db.one(`SELECT COUNT(*) AS n FROM ks_bets WHERE result IS NULL AND live_bet = 0 AND paper = 0 ${uf.clause}`, uf.args),
    db.all(
      `SELECT result FROM ks_bets WHERE result IN ('win','loss') AND live_bet = 0 AND paper = 0 ORDER BY settled_at DESC, id DESC LIMIT 10`
    ),
    db.one(`
      SELECT
        SUM(CASE WHEN result IN ('win','loss') THEN COALESCE(pnl,0) ELSE 0 END) AS total_pnl,
        SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN result IS NULL  THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN bet_date = ? AND result IN ('win','loss') THEN COALESCE(pnl,0) ELSE 0 END) AS today_pnl
      FROM ks_bets WHERE live_bet = 0 AND paper = 0
    `, [today]),
  ])

  const wins   = Number(totals?.wins   || 0)
  const losses = Number(totals?.losses || 0)

  const streak = computeCurrentStreak(recentBets.map(r => r.result))
  const last5  = recentBets.slice(0, 5)
  const last5W = last5.filter(r => r.result === 'win').length
  const last5L = last5.filter(r => r.result === 'loss').length

  // Period P&L — prefer daily_pnl_events (Kalshi-confirmed), fall back to ks_bets
  const dpnl = await getPnlFromDailyEvents(db, { userId: uf.userId, today, weekAgo, monthAgo, yearStart })
  const useDailyEvents = dpnl.event_count > 0
  const todayPnl  = useDailyEvents ? dpnl.today_pnl  : Number(totals?.today_pnl_fallback  || 0)
  const weekPnl   = useDailyEvents ? dpnl.week_pnl   : Number(totals?.week_pnl_fallback   || 0)
  const monthPnl  = useDailyEvents ? dpnl.month_pnl  : Number(totals?.month_pnl_fallback  || 0)
  const ytdPnl    = useDailyEvents ? dpnl.ytd_pnl    : Number(totals?.ytd_pnl_fallback    || 0)

  let kalshiBalance = null, kalshiCash = null, kalshiExposure = null
  try {
    const kb = uf.userId
      ? await (async () => {
          const u = await db.one(`SELECT kalshi_key_id, kalshi_private_key FROM users WHERE id=?`, [uf.userId])
          const creds = u?.kalshi_key_id ? { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key } : {}
          return getKalshiBalance(creds)
        })()
      : await getKalshiBalance()
    kalshiBalance  = kb.balance_usd
    kalshiCash     = kb.cash_usd
    kalshiExposure = kb.exposure_usd
  } catch {}

  let startingBankroll = STARTING_BANKROLL
  let kalshiPnl = null
  if (uf.userId) {
    const uRow = await db.one(`SELECT starting_bankroll, kalshi_pnl FROM users WHERE id=?`, [uf.userId]).catch(() => null)
    if (uRow?.starting_bankroll) startingBankroll = Number(uRow.starting_bankroll)
    if (uRow?.kalshi_pnl != null) kalshiPnl = Number(uRow.kalshi_pnl)
  }
  // All-time P&L: users.kalshi_pnl (fills+settlements) > ytd from daily_pnl_events > ks_bets fallback
  const allTimePnl = kalshiPnl != null ? roundTo(kalshiPnl, 2) : roundTo(ytdPnl, 2)

  res.json({
    today_pnl:       roundTo(todayPnl, 2),
    week_pnl:        roundTo(weekPnl, 2),
    month_pnl:       roundTo(monthPnl, 2),
    ytd_pnl:         roundTo(ytdPnl, 2),
    total_pnl:       allTimePnl,
    wins, losses,
    win_rate:        wins + losses > 0 ? roundTo(wins / (wins + losses), 4) : 0,
    settled:         Number(totals?.settled    || 0),
    total_bets:      Number(totals?.total_bets || 0),
    pending:         Number(pending?.n || 0),
    avg_edge:        totals?.avg_edge != null ? roundTo(totals.avg_edge, 4) : 0,
    bankroll:        kalshiBalance ?? roundTo(startingBankroll + allTimePnl, 2),
    kalshi_balance:  kalshiBalance,
    kalshi_cash:     kalshiCash     ?? null,
    kalshi_exposure: kalshiExposure ?? null,
    start_bankroll:  startingBankroll,
    current_streak:  streak,
    last5:           last5.length ? `${last5W}-${last5L}` : null,
    live_pnl:        roundTo(Number(liveTotals?.total_pnl || 0), 2),
    live_today_pnl:  roundTo(Number(liveTotals?.today_pnl || 0), 2),
    live_wins:       Number(liveTotals?.wins    || 0),
    live_losses:     Number(liveTotals?.losses  || 0),
    live_pending:    Number(liveTotals?.pending || 0),
    live_bankroll:   roundTo(110 + Number(liveTotals?.total_pnl || 0), 2),
  })
}))

router.get('/ks/bettors', wrap(async (req, res) => {
  const today   = todayISO()
  const bettors = await db.all(
    `SELECT id, name, starting_bankroll, daily_risk_pct, paper, paper_temp, kalshi_key_id, kalshi_private_key, kalshi_pnl
     FROM users WHERE active_bettor = 1 AND is_system_admin = 0 ORDER BY id ASC`
  )

  const result = await Promise.all(bettors.map(async u => {
    const row = await db.one(`
      SELECT
        ROUND(SUM(CASE WHEN result IN ('win','loss') THEN COALESCE(pnl,0) ELSE 0 END), 2)           AS total_pnl,
        ROUND(SUM(CASE WHEN result IN ('win','loss') THEN COALESCE(capital_at_risk,0) ELSE 0 END),2) AS total_wagered,
        ROUND(SUM(CASE WHEN bet_date=? AND result IN ('win','loss') THEN COALESCE(pnl,0) ELSE 0 END),2) AS today_pnl,
        ROUND(SUM(CASE WHEN bet_date=? AND result IN ('win','loss') THEN COALESCE(capital_at_risk,0) ELSE 0 END),2) AS today_wagered,
        SUM(CASE WHEN result='win'  AND live_bet=0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN result='loss' AND live_bet=0 THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN result IS NULL AND live_bet=0 THEN 1 ELSE 0 END) AS pending
      FROM ks_bets WHERE user_id=? AND live_bet=0 AND paper=0
    `, [today, today, u.id])

    const creds = u.kalshi_key_id
      ? { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key }
      : {}
    let kalshiBalance = null, kalshiCash = null, kalshiExposure = null
    const cached = _balanceCache.get(u.id)
    if (cached && Date.now() - cached.ts < BALANCE_CACHE_MS) {
      kalshiBalance  = cached.balance_usd
      kalshiCash     = cached.cash_usd
      kalshiExposure = cached.exposure_usd
    } else {
      try {
        const kb = await getKalshiBalance(creds)
        kalshiBalance  = kb.balance_usd
        kalshiCash     = kb.cash_usd
        kalshiExposure = kb.exposure_usd
        _balanceCache.set(u.id, { ts: Date.now(), balance_usd: kalshiBalance, cash_usd: kalshiCash, exposure_usd: kalshiExposure })
      } catch {}
    }

    const existingPnl = await db.one(
      `SELECT COUNT(*) as n FROM daily_pnl_events WHERE user_id = ? AND date = ?`, [u.id, today]
    ).catch(() => null)
    if (!existingPnl?.n && (creds.keyId || process.env.KALSHI_KEY_ID)) {
      await seedDailyPnlFromRest(u.id, creds).catch(() => {})
    }
    const [pnlRow, bestCaseRow, snapshotRow, bdRow, ksBetsSettledRow, pendingLockedRow] = await Promise.all([
      db.one(
        `SELECT COALESCE(SUM(pnl_usd), 0) AS pnl FROM daily_pnl_events WHERE user_id = ? AND date = ?`,
        [u.id, today]
      ).catch(() => null),
      db.one(`
        SELECT COALESCE(SUM(
          CASE WHEN side = 'YES' THEN
            CASE WHEN filled_contracts > 0 AND fill_price IS NOT NULL
              THEN filled_contracts * MAX((1.0-fill_price/100.0)*0.93, (1.0-fill_price/100.0)-0.0175)
              ELSE COALESCE(bet_size,0) * (1.0 - (COALESCE(market_mid,50)/100.0 + COALESCE(spread,4)/200.0)) * 0.93
            END
          ELSE
            CASE WHEN filled_contracts > 0 AND fill_price IS NOT NULL
              THEN filled_contracts * MAX((1.0-fill_price/100.0)*0.93, (1.0-fill_price/100.0)-0.0175)
              ELSE COALESCE(bet_size,0) * (1.0 - ((100.0-COALESCE(market_mid,50))/100.0 + COALESCE(spread,4)/200.0)) * 0.93
            END
          END
        ), 0) AS open_win_potential
        FROM ks_bets
        WHERE user_id = ? AND bet_date = ? AND paper = 0
          AND result IS NULL
          AND filled_contracts > 0
      `, [u.id, today]).catch(() => null),
      db.one(
        `SELECT balance_usd FROM balance_snapshots WHERE user_id = ? AND date = ?`,
        [u.id, today]
      ).catch(() => null),
      db.one(`
        SELECT
          COALESCE(SUM(CASE WHEN live_bet=0
            THEN CASE WHEN result IS NULL THEN COALESCE(capital_at_risk,0)
                      ELSE COALESCE(bet_size * fill_price / 100.0, capital_at_risk, 0) END
            ELSE 0 END), 0) AS pregame_used,
          COALESCE(SUM(CASE WHEN live_bet=1
            AND (bet_mode IS NULL OR bet_mode NOT IN ('pulled','crossed-yes','blowout','dead-path'))
            THEN CASE WHEN result IS NULL THEN COALESCE(capital_at_risk,0)
                      ELSE COALESCE(filled_contracts * fill_price / 100.0, capital_at_risk, 0) END
            ELSE 0 END), 0) AS ingame_used,
          COALESCE(SUM(CASE WHEN live_bet=1
            AND bet_mode IN ('pulled','crossed-yes','blowout','dead-path')
            THEN CASE WHEN result IS NULL THEN COALESCE(capital_at_risk,0)
                      ELSE COALESCE(filled_contracts * fill_price / 100.0, capital_at_risk, 0) END
            ELSE 0 END), 0) AS freemoney_used
        FROM ks_bets WHERE user_id=? AND bet_date=? AND paper=0
      `, [u.id, today]).catch(() => null),
      db.one(
        // Priority: Kalshi-confirmed pnl_usd from daily_pnl_events (exact settlement amount).
        // Fallback: computed from fill data (fee paid at fill, so locked win = contracts × (1-fill)).
        // Final fallback: stored pnl column (older bets without fill data).
        `SELECT COALESCE(SUM(
           COALESCE(
             dpnl.pnl_usd,
             CASE b.result
               WHEN 'win'  THEN CASE WHEN b.filled_contracts > 0 AND b.fill_price > 0
                                THEN b.filled_contracts * (1.0 - b.fill_price / 100.0)
                                ELSE b.pnl END
               WHEN 'loss' THEN CASE WHEN b.filled_contracts > 0 AND b.fill_price > 0
                                THEN -b.filled_contracts * (b.fill_price / 100.0)
                                ELSE b.pnl END
               ELSE b.pnl
             END
           )
         ), 0) AS pnl
         FROM ks_bets b
         LEFT JOIN daily_pnl_events dpnl
           ON dpnl.ticker  = b.ticker
          AND dpnl.user_id = b.user_id
          AND dpnl.date    = b.bet_date
         WHERE b.user_id = ? AND b.bet_date = ?
           AND b.result IN ('win','loss')
           AND b.paper = 0`,
        [u.id, today]
      ).catch(() => null),
      db.one(
        // Wins locked in our system but not yet settled/paid by Kalshi (no daily_pnl_events entry).
        // projected_bank = kalshi_cash + this amount.
        `SELECT COALESCE(SUM(
           b.filled_contracts * (1.0 - b.fill_price / 100.0)
         ), 0) AS pnl
         FROM ks_bets b
         LEFT JOIN daily_pnl_events dpnl
           ON dpnl.ticker  = b.ticker
          AND dpnl.user_id = b.user_id
          AND dpnl.date    = b.bet_date
         WHERE b.user_id = ? AND b.bet_date = ?
           AND b.result = 'win'
           AND b.paper = 0
           AND b.filled_contracts > 0 AND b.fill_price > 0
           AND dpnl.pnl_usd IS NULL`,
        [u.id, today]
      ).catch(() => null),
    ])
    // Always use ks_bets settled P&L for today's intraday LOCKED display.
    // The system marks bets win/loss in real-time; daily_pnl_events lags by hours and
    // partially populates during the day, causing the display to drop mid-day when Kalshi
    // settles only some bets. ks_bets is authoritative for the current-day intraday view.
    const snapshotBalance = snapshotRow?.balance_usd != null ? Number(snapshotRow.balance_usd) : null
    const todayPnl = roundTo(Number(ksBetsSettledRow?.pnl || 0), 2)
    const pendingLockedPnl = roundTo(Number(pendingLockedRow?.pnl || 0), 2)
    const projectedBank = kalshiCash != null ? roundTo(kalshiCash + pendingLockedPnl, 2) : null
    const openWinPotential = roundTo(Number(bestCaseRow?.open_win_potential || 0), 2)
    const bestCase         = openWinPotential
    const startBankroll = Number(u.starting_bankroll || 1000)
    // Use fills+settlements based P&L (stored by settlement sync) — includes bets placed outside the system
    const allTimePnl   = u.kalshi_pnl != null ? roundTo(u.kalshi_pnl, 2) : roundTo(Number(row?.total_pnl || 0), 2)

    return {
      id:              u.id,
      name:            u.name,
      start_bankroll:  startBankroll,
      bankroll:        kalshiBalance ?? roundTo(startBankroll + Number(row?.total_pnl || 0), 2),
      kalshi_balance:  kalshiBalance,
      kalshi_cash:     kalshiCash     ?? null,
      kalshi_exposure: kalshiExposure ?? null,
      total_pnl:       allTimePnl,
      db_total_pnl:    roundTo(Number(row?.total_pnl    || 0), 2),
      total_wagered:   roundTo(Number(row?.total_wagered || 0), 2),
      today_pnl:       todayPnl,
      projected_bank:  projectedBank,
      best_case:       bestCase,
      start_balance:   snapshotBalance ?? (kalshiBalance != null ? roundTo(kalshiBalance - todayPnl, 2) : null),
      today_wagered:   roundTo(Number(row?.today_wagered || 0), 2),
      wins:            Number(row?.wins    || 0),
      losses:          Number(row?.losses  || 0),
      pending:         Number(row?.pending || 0),
      daily_risk_pct:  Number(u.daily_risk_pct || 0.3),
      paper:           u.paper === 1,
      pregame_budget:  roundTo((kalshiBalance ?? startBankroll) * 0.70, 2),
      pregame_used:    roundTo(Number(bdRow?.pregame_used   || 0), 2),
      ingame_budget:   roundTo((kalshiBalance ?? startBankroll) * 0.20, 2),
      ingame_used:     roundTo(Number(bdRow?.ingame_used    || 0), 2),
      freemoney_used:  roundTo(Number(bdRow?.freemoney_used || 0), 2),
    }
  }))

  res.json(result)
}))

router.post('/ks/reconcile', wrap(async (req, res) => {
  const bettors = await db.all(`SELECT id, name, kalshi_key_id, kalshi_private_key FROM users WHERE active_bettor=1 AND is_system_admin = 0`)
  const results = await Promise.all(bettors.map(async u => {
    if (!u.kalshi_key_id) return { id: u.id, name: u.name, skipped: true }
    const r = await forceSync(u).catch(e => ({ error: e.message }))
    return { id: u.id, name: u.name, ...r }
  }))
  res.json({ ok: true, results })
}))

router.get('/ks/dates', wrap(async (req, res) => {
  const uf   = userFilter(req)
  const rows = await db.all(
    `SELECT DISTINCT bet_date FROM ks_bets WHERE live_bet = 0 AND paper = 0 ${uf.clause} ORDER BY bet_date DESC LIMIT 60`,
    uf.args,
  )
  res.json(rows.map(r => r.bet_date).filter(Boolean))
}))

router.get('/ks/daily', wrap(async (req, res) => {
  const date = req.query.date && req.query.date !== 'today' ? req.query.date : todayISO()
  const uf   = userFilter(req)

  const lastFill = getLastFillEventAt()
  if (uf.userId && date === todayISO() && (!lastFill || Date.now() - lastFill > 60_000)) {
    const u = await db.one(`SELECT id, kalshi_key_id, kalshi_private_key FROM users WHERE id = ?`, [uf.userId])
    if (u) {
      syncFillsForBettor(u).catch(() => {})
      reconcilePositionsForBettor(u).catch(() => {})
    }
  }

  const bets = await db.all(
    `SELECT id, bet_date, logged_at, pitcher_name, pitcher_id, team, game,
            strike, side, model_prob, market_mid, edge, lambda, actual_ks,
            result, pnl, bet_size, kelly_fraction, ticker, live_bet,
            park_factor, ump_factor, ump_name, velo_adj, bb_penalty,
            spread, k9_career, k9_season, k9_l5,
            savant_k_pct, savant_whiff, savant_fbv,
            weather_mult, velo_trend_mph, raw_model_prob,
            order_id, fill_price, filled_at, filled_contracts, order_status, paper,
            bet_mode, capital_at_risk, live_ks_at_bet, live_ip_at_bet, live_inning
     FROM ks_bets
     WHERE bet_date = ? AND live_bet = 0
       AND filled_contracts > 0
       ${uf.clause}
     ORDER BY pitcher_name, strike ASC`,
    [date, ...uf.args],
  )

  const liveKey = b => `${b.pitcher_name}|${b.strike}|${b.side}`
  const liveMap = new Map()
  for (const lb of bets) liveMap.set(liveKey(lb), lb)

  const pitcherMap = new Map()
  for (const b of bets) {
    const key = `${b.pitcher_name}||${b.game || ''}`
    if (!pitcherMap.has(key)) {
      pitcherMap.set(key, {
        pitcher_name: b.pitcher_name, pitcher_id: b.pitcher_id,
        team: b.team, game: b.game, lambda: b.lambda,
        actual_ks: b.actual_ks, bets: [],
      })
    }
    const grp = pitcherMap.get(key)
    if (b.actual_ks != null && grp.actual_ks == null) grp.actual_ks = b.actual_ks
    grp.bets.push({
      id: b.id, bet_date: b.bet_date, strike: b.strike, side: b.side,
      model_prob:       b.model_prob   != null ? roundTo(b.model_prob, 4)   : null,
      market_mid:       b.market_mid,
      edge:             b.edge         != null ? roundTo(b.edge, 4)         : null,
      bet_size:         b.bet_size,
      kelly_fraction:   b.kelly_fraction,
      actual_ks:        b.actual_ks ?? null,
      result:           b.result,
      pnl:              b.pnl          != null ? roundTo(b.pnl, 2)          : null,
      ticker:           b.ticker,
      spread:           b.spread,
      lambda:           b.lambda,
      park_factor:      b.park_factor,
      ump_factor:       b.ump_factor,
      ump_name:         b.ump_name,
      weather_mult:     b.weather_mult,
      velo_trend_mph:   b.velo_trend_mph,
      raw_model_prob:   b.raw_model_prob != null ? roundTo(b.raw_model_prob, 4) : null,
      k9_season:        b.k9_season,
      savant_k_pct:     b.savant_k_pct,
      savant_whiff:     b.savant_whiff,
      savant_fbv:       b.savant_fbv,
      logged_at:        b.logged_at        ?? null,
      order_id:         b.order_id         ?? null,
      fill_price:       b.fill_price       ?? null,
      filled_at:        b.filled_at        ?? null,
      filled_contracts: b.filled_contracts ?? null,
      order_status:     b.order_status     ?? null,
      paper:            b.paper            ?? 1,
      bet_mode:         b.bet_mode         ?? null,
      capital_at_risk:  b.capital_at_risk  ?? null,
      live_ks_at_bet:   b.live_ks_at_bet   ?? null,
      live_ip_at_bet:   b.live_ip_at_bet   ?? null,
      live_inning:      b.live_inning      ?? null,
      live: (() => {
        const lb = liveMap.get(`${b.pitcher_name}|${b.strike}|${b.side}`)
        if (!lb) return null
        return {
          bet_size: lb.bet_size, fill_price: lb.fill_price,
          filled_contracts: lb.filled_contracts, order_id: lb.order_id,
          order_status: lb.order_status, result: lb.result,
          pnl: lb.pnl != null ? roundTo(lb.pnl, 2) : null,
        }
      })(),
    })
  }

  const pitcherIdList = [...new Set([...pitcherMap.values()].map(g => g.pitcher_id).filter(Boolean))]
  let recentStartsMap = {}, gameTimeMap = {}
  if (pitcherIdList.length) {
    const ph = pitcherIdList.map(() => '?').join(',')
    const [startRows, gameRows] = await Promise.all([
      db.all(
        `SELECT pitcher_id, game_date, ks FROM pitcher_recent_starts
         WHERE pitcher_id IN (${ph}) ORDER BY pitcher_id, game_date DESC`,
        pitcherIdList,
      ),
      db.all(
        `SELECT pitcher_home_id AS pid, game_time, status FROM games WHERE date = ? AND pitcher_home_id IN (${ph})
         UNION
         SELECT pitcher_away_id AS pid, game_time, status FROM games WHERE date = ? AND pitcher_away_id IN (${ph})`,
        [date, ...pitcherIdList, date, ...pitcherIdList],
      ),
    ])
    for (const r of startRows) {
      if (!recentStartsMap[r.pitcher_id]) recentStartsMap[r.pitcher_id] = []
      if (recentStartsMap[r.pitcher_id].length < 5) recentStartsMap[r.pitcher_id].push(r.ks)
    }
    for (const r of gameRows) {
      if (r.pid) gameTimeMap[r.pid] = { game_time: r.game_time, status: r.status }
    }
  }

  const pitchers = []
  let day_pnl = 0, day_wins = 0, day_losses = 0, day_pending = 0
  for (const [, grp] of pitcherMap) {
    let p_pnl = 0, p_wins = 0, p_losses = 0, p_pending = 0
    for (const b of grp.bets) {
      if (b.result === 'win')        { p_wins++;   p_pnl += Number(b.pnl || 0) }
      else if (b.result === 'loss')  { p_losses++; p_pnl += Number(b.pnl || 0) }
      else if (b.result !== 'void')  p_pending++
    }
    day_pnl     += p_pnl
    day_wins    += p_wins
    day_losses  += p_losses
    day_pending += p_pending
    const gt = gameTimeMap[grp.pitcher_id] || {}
    pitchers.push({
      ...grp,
      game_time:   gt.game_time || null,
      game_status: gt.status    || null,
      pnl:         roundTo(p_pnl, 2),
      wins:        p_wins,
      losses:      p_losses,
      pending:     p_pending,
      recent_ks:   recentStartsMap[grp.pitcher_id] || [],
    })
  }

  pitchers.sort((a, b) => {
    const rank = s => s === 'in_progress' ? 0 : s === 'final' ? 2 : 1
    const dr = rank(a.game_status) - rank(b.game_status)
    if (dr !== 0) return dr
    if (a.game_time && b.game_time) return a.game_time.localeCompare(b.game_time)
    if (a.game_time) return -1
    if (b.game_time) return 1
    return a.pitcher_name.localeCompare(b.pitcher_name)
  })

  const liveRow = await db.one(
    `SELECT COALESCE(SUM(pnl), 0) AS pnl, COUNT(*) AS bets,
            SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
            SUM(CASE WHEN result IS NULL THEN 1 ELSE 0 END) AS pending
     FROM ks_bets WHERE bet_date=? AND live_bet=1 AND paper=0 ${uf.clause}`,
    [date, ...uf.args],
  ).catch(() => null)

  const live_day_pnl    = roundTo(Number(liveRow?.pnl     || 0), 2)
  const live_day_wins   = Number(liveRow?.wins    || 0)
  const live_day_losses = Number(liveRow?.losses  || 0)
  const live_day_pending= Number(liveRow?.pending || 0)

  res.json({
    date,
    day_pnl:     roundTo(day_pnl + live_day_pnl, 2),
    day_wins:    day_wins  + live_day_wins,
    day_losses:  day_losses + live_day_losses,
    day_pending: day_pending + live_day_pending,
    day_bets:    bets.length,
    pitchers,
  })
}))

router.get('/ks/recent-starts/:pitcher_id', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT game_date, ks, ip, bf FROM pitcher_recent_starts
     WHERE pitcher_id = ?
     ORDER BY game_date DESC LIMIT 5`,
    [req.params.pitcher_id]
  )
  res.json(rows)
}))

router.get('/ks/bankroll', wrap(async (req, res) => {
  const { from, to, user_id } = req.query
  const clauses = ["result IN ('win','loss')", 'live_bet = 0', 'paper = 0']
  const args    = []
  if (user_id) { clauses.push('user_id = ?'); args.push(user_id) }
  if (from)    { clauses.push('bet_date >= ?'); args.push(from) }
  if (to)      { clauses.push('bet_date <= ?'); args.push(to) }
  const where = clauses.join(' AND ')

  let startingBalance = STARTING_BANKROLL
  if (from) {
    const prior = await db.all(
      `SELECT SUM(COALESCE(pnl,0)) AS prior_pnl FROM ks_bets WHERE result IN ('win','loss') AND live_bet=0 AND paper=0 AND bet_date < ?`,
      [from]
    )
    startingBalance = STARTING_BANKROLL + Number(prior[0]?.prior_pnl || 0)
  }

  const rows = await db.all(
    `SELECT bet_date, SUM(COALESCE(pnl, 0)) AS day_pnl, COUNT(*) AS bets,
            SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses
     FROM ks_bets WHERE ${where}
     GROUP BY bet_date ORDER BY bet_date ASC`,
    args
  )
  let running = startingBalance
  res.json(rows.map(r => {
    const pnl = Number(r.day_pnl || 0)
    running += pnl
    return {
      date:     r.bet_date,
      bankroll: roundTo(running, 2),
      pnl:      roundTo(pnl, 2),
      bets:     Number(r.bets    || 0),
      wins:     Number(r.wins    || 0),
      losses:   Number(r.losses  || 0),
    }
  }))
}))

router.get('/ks/monthly', wrap(async (req, res) => {
  const { from, to, user_id } = req.query
  const clauses = ['live_bet = 0', "result IN ('win','loss')", 'paper = 0']
  const args    = []
  if (user_id) { clauses.push('user_id = ?'); args.push(user_id) }
  if (from)    { clauses.push('bet_date >= ?'); args.push(from) }
  if (to)      { clauses.push('bet_date <= ?'); args.push(to) }
  const rows = await db.all(
    `SELECT substr(bet_date,1,7) AS ym,
            COUNT(*)                                          AS bets,
            SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END)   AS wins,
            SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END)   AS losses,
            SUM(COALESCE(pnl,0))                             AS pnl,
            SUM(COALESCE(capital_at_risk, bet_size))         AS wagered,
            AVG(edge)                                        AS avg_edge
     FROM ks_bets WHERE ${clauses.join(' AND ')}
     GROUP BY ym ORDER BY ym ASC`,
    args
  )
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  let running = STARTING_BANKROLL
  res.json(rows.map(r => {
    const wins    = Number(r.wins    || 0)
    const losses  = Number(r.losses  || 0)
    const pnl     = Number(r.pnl     || 0)
    const wagered = Number(r.wagered || 0)
    running += pnl
    const [y, mo] = String(r.ym).split('-')
    return {
      month:    `${months[Number(mo)-1] || mo} ${y}`,
      ym:       r.ym,
      bets:     Number(r.bets || 0),
      wins, losses,
      win_rate: wins + losses > 0 ? roundTo(wins/(wins+losses), 4) : 0,
      pnl:      roundTo(pnl, 2),
      roi:      wagered > 0 ? roundTo(pnl/wagered, 4) : 0,
      avg_edge: r.avg_edge != null ? roundTo(r.avg_edge, 4) : 0,
      bankroll: roundTo(running, 2),
    }
  }))
}))

router.get('/ks/weekly', wrap(async (req, res) => {
  const { from, to, user_id } = req.query
  const clauses = ['live_bet = 0', "result IN ('win','loss')", 'paper = 0']
  const args    = []
  if (user_id) { clauses.push('user_id = ?'); args.push(user_id) }
  if (from)    { clauses.push('bet_date >= ?'); args.push(from) }
  if (to)      { clauses.push('bet_date <= ?'); args.push(to) }
  const rows = await db.all(
    `SELECT bet_date, COALESCE(pnl,0) AS pnl, result, bet_size, capital_at_risk
     FROM ks_bets WHERE ${clauses.join(' AND ')} ORDER BY bet_date ASC`,
    args
  )
  if (!rows.length) return res.json([])
  const weeks = {}
  for (const r of rows) {
    const { key, label } = isoWeekGroup(r.bet_date)
    const w = (weeks[key] ||= { week: label, start: key, bets:0, wins:0, losses:0, pnl:0, wagered:0 })
    w.bets    += 1
    w.wagered += Number(r.capital_at_risk || r.bet_size || 0)
    if (r.result === 'win')       w.wins++
    else if (r.result === 'loss') w.losses++
    w.pnl += Number(r.pnl || 0)
  }
  res.json(Object.values(weeks).sort((a,b) => a.start.localeCompare(b.start)).map(w => ({
    week:     w.week,
    bets:     w.bets,
    wins:     w.wins,
    losses:   w.losses,
    win_rate: w.wins+w.losses > 0 ? roundTo(w.wins/(w.wins+w.losses),4) : 0,
    pnl:      roundTo(w.pnl, 2),
    roi:      w.wagered > 0 ? roundTo(w.pnl/w.wagered, 4) : 0,
  })))
}))

router.get('/ks/bets', wrap(async (req, res) => {
  const page   = Math.max(1, Number(req.query.page   || 1))
  const limit  = Math.min(200, Number(req.query.limit || 50))
  const offset = (page - 1) * limit
  const uf     = userFilter(req)

  let where  = `live_bet = 0 AND paper = 0 ${uf.clause}`
  const params = [...uf.args]
  if (req.query.pitcher) { where += ` AND pitcher_name LIKE ?`; params.push(`%${req.query.pitcher}%`) }
  if (req.query.side)    { where += ` AND side = ?`;    params.push(req.query.side.toUpperCase()) }
  if (req.query.result)  { where += ` AND result = ?`;  params.push(req.query.result.toLowerCase()) }
  if (req.query.from)    { where += ` AND bet_date >= ?`; params.push(req.query.from) }
  if (req.query.to)      { where += ` AND bet_date <= ?`; params.push(req.query.to) }

  const ALLOWED_SORT = new Set(['bet_date','pitcher_name','strike','side','actual_ks','result','pnl','bet_size','edge'])
  const sortCol = ALLOWED_SORT.has(req.query.sort) ? req.query.sort : 'bet_date'
  const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC'
  const orderBy = sortCol === 'bet_date' ? `bet_date ${sortDir}, id ${sortDir}` : `${sortCol} ${sortDir}, bet_date DESC`

  const [rows, countRow] = await Promise.all([
    db.all(
      `SELECT id, pitcher_id, bet_date, pitcher_name, team, game, strike, side,
              model_prob, market_mid, spread, edge, lambda, actual_ks, result, pnl, bet_size, capital_at_risk, ticker
       FROM ks_bets WHERE ${where}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    db.one(`SELECT COUNT(*) AS n FROM ks_bets WHERE ${where}`, params),
  ])

  res.json({
    bets: rows.map(r => ({
      ...r,
      model_prob: r.model_prob != null ? roundTo(r.model_prob, 4) : null,
      edge:       r.edge       != null ? roundTo(r.edge, 4)       : null,
      pnl:        r.pnl        != null ? roundTo(r.pnl, 2)        : null,
    })),
    total: Number(countRow?.n || 0),
    page, limit,
    pages: Math.ceil(Number(countRow?.n || 0) / limit),
  })
}))

// ── Decision Pipeline routes ──────────────────────────────────────────────────

function parsePipelineRow(row) {
  if (!row) return null
  const parsed = { ...row }
  for (const col of ['model_input_json','lambda_calc_json','edges_json',
                     'rule_filters_json','preflight_json','bets_placed_json']) {
    if (parsed[col]) { try { parsed[col] = JSON.parse(parsed[col]) } catch { parsed[col] = null } }
  }
  return parsed
}

router.get('/ks/pipeline/dates', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT bet_date, COUNT(*) AS n FROM decision_pipeline
      GROUP BY bet_date ORDER BY bet_date DESC LIMIT 60`,
  )
  res.json({ dates: rows.map(r => ({ date: r.bet_date, n: Number(r.n) })) })
}))

router.get('/ks/pipeline/by-bet/:ks_bet_id', wrap(async (req, res) => {
  const bet = await db.one(
    `SELECT bet_date, pitcher_id FROM ks_bets WHERE id=?`, [req.params.ks_bet_id],
  )
  if (!bet) return res.status(404).json({ error: 'bet_not_found' })
  const row = await db.one(
    `SELECT * FROM decision_pipeline WHERE bet_date=? AND pitcher_id=?`,
    [bet.bet_date, String(bet.pitcher_id)],
  )
  const parsed = parsePipelineRow(row)
  if (!parsed) return res.status(404).json({ error: 'no_pipeline_data' })
  res.json(parsed)
}))

router.get('/ks/pipeline', wrap(async (req, res) => {
  const date = req.query.date || todayISO()
  const rows = await db.all(
    `SELECT id, bet_date, pitcher_id, pitcher_name, game_id, game_label,
            pitcher_side, game_time, status, final_action, n_markets, n_edges,
            n_bets_logged, best_edge, lambda, confidence, skip_reason,
            created_at, updated_at
       FROM decision_pipeline
      WHERE bet_date = ?
      ORDER BY game_time ASC, pitcher_name ASC`,
    [date],
  )
  const pitcherIds = rows.map(r => String(r.pitcher_id))
  let outcomes = new Map()
  if (pitcherIds.length) {
    const ph = pitcherIds.map(() => '?').join(',')
    const bets = await db.all(
      `SELECT pitcher_id,
              SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
              SUM(COALESCE(pnl,0)) AS pnl
         FROM ks_bets WHERE bet_date=? AND live_bet=0 AND paper=0
           AND pitcher_id IN (${ph})
         GROUP BY pitcher_id`,
      [date, ...pitcherIds],
    )
    outcomes = new Map(bets.map(b => [String(b.pitcher_id), b]))
  }
  res.json({
    date,
    pitchers: rows.map(r => ({ ...r, outcome: outcomes.get(String(r.pitcher_id)) || null })),
  })
}))

router.get('/ks/pipeline/:bet_date/:pitcher_id', wrap(async (req, res) => {
  const { bet_date, pitcher_id } = req.params
  const row = await db.one(
    `SELECT * FROM decision_pipeline WHERE bet_date=? AND pitcher_id=?`,
    [bet_date, String(pitcher_id)],
  )
  const parsed = parsePipelineRow(row)
  if (!parsed) return res.status(404).json({ error: 'not_found' })
  res.json(parsed)
}))

router.get('/ks/stats', wrap(async (req, res) => {
  const { from, to, user_id } = req.query
  const clauses = ['live_bet = 0', "result IN ('win','loss')", 'paper = 0']
  const args    = []
  if (user_id) { clauses.push('user_id = ?'); args.push(user_id) }
  if (from)    { clauses.push('bet_date >= ?'); args.push(from) }
  if (to)      { clauses.push('bet_date <= ?'); args.push(to) }
  const where = clauses.join(' AND ')

  const [[agg], [days], seqRows] = await Promise.all([
    db.all(
      `SELECT
         COUNT(CASE WHEN result='win'  THEN 1 END)                          AS wins,
         COUNT(CASE WHEN result='loss' THEN 1 END)                          AS losses,
         COALESCE(SUM(pnl), 0)                                              AS total_pnl,
         COALESCE(SUM(bet_size), 0)                                         AS total_wagered,
         COALESCE(SUM(CASE WHEN side='YES' THEN model_prob ELSE 1-model_prob END), 0) AS expected_wins,
         AVG(CASE WHEN result='win'  AND edge IS NOT NULL THEN edge END)    AS avg_edge_wins,
         AVG(CASE WHEN result='loss' AND edge IS NOT NULL THEN edge END)    AS avg_edge_losses
       FROM ks_bets WHERE ${where}`,
      args,
    ),
    db.all(
      `SELECT
         COUNT(*)                                              AS total_days,
         SUM(CASE WHEN day_pnl > 0 THEN 1 ELSE 0 END)        AS winning_days
       FROM (SELECT SUM(pnl) AS day_pnl FROM ks_bets WHERE ${where} GROUP BY bet_date)`,
      args,
    ),
    // Only fetch what's needed for sequential drawdown + streak computation
    db.all(
      `SELECT pnl, result FROM ks_bets WHERE ${where} ORDER BY bet_date ASC, id ASC`,
      args,
    ),
  ])

  if (!agg || (agg.wins === 0 && agg.losses === 0)) {
    return res.json({
      empty: true, wins: 0, losses: 0, total_pnl: 0, total_wagered: 0,
      win_rate: 0, roi: 0, ev_per_bet: 0, max_drawdown: 0, max_drawdown_pct: 0,
      current_drawdown: 0, current_drawdown_pct: 0, longest_win_streak: 0,
      longest_loss_streak: 0, current_streak: 0, winning_days: 0,
      total_days: 0, winning_days_pct: 0, avg_edge_wins: null,
      avg_edge_losses: null, expected_wins: 0, actual_wins: 0,
      bankroll: STARTING_BANKROLL, start_bankroll: STARTING_BANKROLL,
    })
  }

  // Sequential pass — only drawdown + streaks require ordered rows
  let running = STARTING_BANKROLL, peak = STARTING_BANKROLL
  let maxDd = 0, streak = 0, maxWinStreak = 0, maxLossStreak = 0
  for (const r of seqRows) {
    running += Number(r.pnl || 0)
    peak     = Math.max(peak, running)
    maxDd    = Math.min(maxDd, running - peak)
    if (r.result === 'win') {
      streak = streak >= 0 ? streak + 1 : 1
      maxWinStreak = Math.max(maxWinStreak, streak)
    } else {
      streak = streak <= 0 ? streak - 1 : -1
      maxLossStreak = Math.min(maxLossStreak, streak)
    }
  }

  const wins         = Number(agg.wins         || 0)
  const losses       = Number(agg.losses       || 0)
  const totalPnl     = Number(agg.total_pnl    || 0)
  const totalWagered = Number(agg.total_wagered || 0)
  const totalSettled = wins + losses
  const totalDays    = Number(days?.total_days    || 0)
  const winningDays  = Number(days?.winning_days  || 0)
  const currentDd    = running - peak

  res.json({
    wins, losses,
    total_pnl:            roundTo(totalPnl, 2),
    total_wagered:        roundTo(totalWagered, 2),
    win_rate:             totalSettled > 0 ? roundTo(wins / totalSettled, 4) : 0,
    roi:                  totalWagered > 0 ? roundTo(totalPnl / totalWagered, 4) : 0,
    ev_per_bet:           totalSettled > 0 ? roundTo(totalPnl / totalSettled, 2) : 0,
    max_drawdown:         roundTo(maxDd, 2),
    max_drawdown_pct:     peak > 0 ? roundTo(maxDd / peak, 4) : 0,
    current_drawdown:     roundTo(currentDd, 2),
    current_drawdown_pct: peak > 0 ? roundTo(currentDd / peak, 4) : 0,
    longest_win_streak:   maxWinStreak,
    longest_loss_streak:  Math.abs(maxLossStreak),
    current_streak:       streak,
    winning_days:         winningDays,
    total_days:           totalDays,
    winning_days_pct:     totalDays > 0 ? roundTo(winningDays / totalDays, 4) : 0,
    avg_edge_wins:        agg.avg_edge_wins  != null ? roundTo(Number(agg.avg_edge_wins),  4) : null,
    avg_edge_losses:      agg.avg_edge_losses != null ? roundTo(Number(agg.avg_edge_losses), 4) : null,
    expected_wins:        roundTo(Number(agg.expected_wins || 0), 1),
    actual_wins:          wins,
    bankroll:             roundTo(running, 2),
    start_bankroll:       STARTING_BANKROLL,
  })
}))

router.get('/ks/edge-breakdown', wrap(async (req, res) => {
  const fin = (rows, labelField) => rows.map(r => {
    const total = Number(r.wins || 0) + Number(r.losses || 0)
    return {
      label:    r[labelField],
      bets:     total,
      wins:     Number(r.wins    || 0),
      losses:   Number(r.losses  || 0),
      win_rate: total > 0 ? roundTo(Number(r.wins || 0) / total, 4) : 0,
      pnl:      roundTo(Number(r.pnl     || 0), 2),
      roi:      Number(r.wagered || 0) > 0 ? roundTo(Number(r.pnl || 0) / Number(r.wagered), 4) : 0,
    }
  })

  const base = `FROM ks_bets WHERE live_bet=0 AND result IN ('win','loss') AND paper=0`
  const agg  = `SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
                SUM(pnl) AS pnl,
                SUM(COALESCE(capital_at_risk, bet_size, 0)) AS wagered`

  const [byBucket, bySide, byStrike] = await Promise.all([
    db.all(`SELECT CASE WHEN edge*100 < 7 THEN '5–7¢' WHEN edge*100 < 10 THEN '7–10¢' ELSE '10¢+' END AS label, ${agg} ${base} GROUP BY label`),
    db.all(`SELECT side AS label, ${agg} ${base} GROUP BY side`),
    db.all(`SELECT CAST(strike AS TEXT) || '+' AS label, ${agg} ${base} GROUP BY strike ORDER BY strike`),
  ])

  res.json({
    by_bucket: fin(byBucket, 'label'),
    by_side:   fin(bySide,   'label'),
    by_strike: fin(byStrike, 'label'),
  })
}))

router.get('/ks/pitcher-leaderboard', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT pitcher_name,
            COUNT(*)                                        AS bets,
            SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
            SUM(COALESCE(pnl,0))                           AS pnl,
            SUM(bet_size)                                  AS wagered
     FROM ks_bets WHERE live_bet = 0 AND paper = 0 AND result IN ('win','loss')
     GROUP BY pitcher_name ORDER BY pnl DESC`,
  )
  const all = rows.map(r => {
    const wins    = Number(r.wins    || 0)
    const losses  = Number(r.losses  || 0)
    const pnl     = Number(r.pnl     || 0)
    const wag     = Number(r.wagered || 0)
    return {
      pitcher: r.pitcher_name,
      bets:    Number(r.bets || 0),
      wins, losses,
      win_rate: wins + losses > 0 ? roundTo(wins / (wins + losses), 4) : 0,
      pnl:      roundTo(pnl, 2),
      roi:      wag > 0 ? roundTo(pnl / wag, 4) : 0,
    }
  })
  res.json({ top: all.slice(0, 10), bottom: [...all].slice(-10).reverse() })
}))

router.get('/ks/game-review', wrap(async (req, res) => {
  const { from, to, result } = req.query
  const conds = ['live_bet = 0', 'paper = 0']
  const vals  = []
  if (from)   { conds.push('bet_date >= ?'); vals.push(from) }
  if (to)     { conds.push('bet_date <= ?'); vals.push(to) }
  if (result === 'pending')  { conds.push('result IS NULL') }
  else if (result)           { conds.push('result = ?'); vals.push(result) }

  const rows = await db.all(
    `SELECT bet_date, pitcher_name, pitcher_id, game, team,
            strike, side, edge, lambda, actual_ks, result, pnl, bet_size,
            savant_k_pct, savant_whiff, savant_fbv, opp_k_pct,
            park_factor, weather_mult, ump_factor, ump_name
     FROM ks_bets
     WHERE ${conds.join(' AND ')}
     ORDER BY bet_date DESC, pitcher_name ASC, strike ASC`,
    vals,
  )

  const byDate = {}
  for (const r of rows) {
    const d   = r.bet_date
    if (!byDate[d]) byDate[d] = {}
    const key = `${r.pitcher_name}||${r.game}`
    if (!byDate[d][key]) {
      byDate[d][key] = {
        pitcher_name: r.pitcher_name, pitcher_id: r.pitcher_id,
        game: r.game, team: r.team, lambda: r.lambda,
        actual_ks: r.actual_ks,
        savant_k_pct: r.savant_k_pct, savant_whiff: r.savant_whiff, savant_fbv: r.savant_fbv,
        opp_k_pct: r.opp_k_pct, park_factor: r.park_factor,
        weather_mult: r.weather_mult, ump_factor: r.ump_factor, ump_name: r.ump_name,
        bets: [],
      }
    }
    byDate[d][key].bets.push({ strike: r.strike, side: r.side, edge: r.edge, bet_size: r.bet_size, result: r.result, pnl: r.pnl })
  }

  const output = Object.keys(byDate).sort().reverse().map(date => ({
    date,
    games: Object.values(byDate[date]).map(g => {
      const settled    = g.bets.filter(b => b.result)
      const wins       = settled.filter(b => b.result === 'win').length
      const losses     = settled.filter(b => b.result === 'loss').length
      const pending    = g.bets.filter(b => !b.result).length
      const pnl        = settled.reduce((s, b) => s + Number(b.pnl || 0), 0)
      const lambda_err = g.actual_ks != null ? roundTo(Number(g.lambda || 0) - Number(g.actual_ks), 1) : null
      return { ...g, wins, losses, pending, pnl: roundTo(pnl, 2), lambda_err }
    }),
  }))

  res.json(output)
}))

router.get('/ks/testing', wrap(async (req, res) => {
  const [calibRows, lambdaRows, allSettled] = await Promise.all([
    db.all(`
      SELECT
        CAST(ROUND(edge / 0.05) * 0.05 * 100 AS INTEGER) AS bucket_cents,
        COUNT(*)                                           AS bets,
        SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END)    AS wins,
        SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END)    AS losses,
        SUM(COALESCE(pnl,0))                              AS pnl,
        AVG(edge)                                         AS avg_edge
      FROM ks_bets
      WHERE result IN ('win','loss') AND live_bet = 0 AND paper = 0 AND edge IS NOT NULL
      GROUP BY bucket_cents ORDER BY bucket_cents ASC
    `),
    db.all(`
      SELECT
        pitcher_name,
        AVG(lambda)     AS avg_lambda,
        AVG(actual_ks)  AS avg_actual,
        COUNT(*)        AS bets,
        SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
        SUM(COALESCE(pnl,0)) AS pnl
      FROM ks_bets
      WHERE result IN ('win','loss') AND live_bet = 0 AND paper = 0 AND lambda IS NOT NULL AND actual_ks IS NOT NULL
      GROUP BY pitcher_name HAVING bets >= 3 ORDER BY bets DESC
    `),
    db.all(`
      SELECT edge, result, pnl, bet_size, capital_at_risk
      FROM ks_bets WHERE result IN ('win','loss') AND live_bet = 0 AND paper = 0 AND edge IS NOT NULL ORDER BY edge ASC
    `),
  ])

  const calibration = calibRows.map(r => {
    const wins   = Number(r.wins   || 0)
    const losses = Number(r.losses || 0)
    const pnl    = Number(r.pnl    || 0)
    return {
      bucket_cents: Number(r.bucket_cents),
      bets: Number(r.bets), wins, losses,
      win_rate: wins + losses > 0 ? roundTo(wins / (wins + losses), 4) : 0,
      pnl: roundTo(pnl, 2),
    }
  })

  const lambda_accuracy = lambdaRows.map(r => {
    const wins       = Number(r.wins    || 0)
    const losses     = Number(r.losses  || 0)
    const win_rate   = wins + losses > 0 ? roundTo(wins / (wins + losses), 4) : 0
    const avg_lambda = roundTo(Number(r.avg_lambda || 0), 2)
    const avg_actual = roundTo(Number(r.avg_actual || 0), 2)
    const lambda_err = roundTo(avg_lambda - avg_actual, 2)
    const bets       = Number(r.bets)
    const pnl        = roundTo(Number(r.pnl || 0), 2)
    const notes      = []
    if (lambda_err >= 2.5) notes.push(`Model over-predicts by ${lambda_err}K avg — bets tend to be on inflated lines. Consider skipping or reducing bet size.`)
    else if (lambda_err <= -2.5) notes.push(`Model under-predicts by ${Math.abs(lambda_err)}K avg — actual Ks exceed expectation. Edge may be understated; consider increasing size.`)
    else if (Math.abs(lambda_err) < 0.75) notes.push(`λ is accurate (±${Math.abs(lambda_err)}K avg). Model well-calibrated for this pitcher.`)
    if (win_rate <= 0.25 && bets >= 4) notes.push(`Only ${Math.round(win_rate*100)}% win rate over ${bets} bets — strong flag to skip until model inputs are reviewed.`)
    else if (win_rate === 1 && bets >= 3) notes.push(`${bets} for ${bets} — perfect record. Could be small sample luck; continue with standard sizing.`)
    else if (win_rate >= 0.75 && bets >= 4) notes.push(`${Math.round(win_rate*100)}% win rate over ${bets} bets — one of the better-performing starters in the model.`)
    if (pnl < -30 && bets >= 4) notes.push(`Net -$${Math.abs(pnl).toFixed(0)} across ${bets} bets. Check if a specific strike range is dragging results.`)
    return { pitcher: r.pitcher_name, avg_lambda, avg_actual, lambda_err, bets, wins, losses, win_rate, pnl, notes }
  })

  const thresholds = []
  for (let t = 4; t <= 20; t++) {
    const thresh  = t / 100
    const subset  = allSettled.filter(b => Number(b.edge) >= thresh)
    if (!subset.length) break
    const wins    = subset.filter(b => b.result === 'win').length
    const losses  = subset.filter(b => b.result === 'loss').length
    const pnl     = subset.reduce((s, b) => s + Number(b.pnl || 0), 0)
    const wagered = subset.reduce((s, b) => s + Number(b.capital_at_risk || b.bet_size || 0), 0)
    thresholds.push({
      threshold_cents: t, bets: subset.length, wins, losses,
      win_rate: wins + losses > 0 ? roundTo(wins / (wins + losses), 4) : 0,
      pnl:      roundTo(pnl, 2),
      roi:      wagered > 0 ? roundTo(pnl / wagered, 4) : 0,
    })
  }

  const model_notes = []
  const bestThresh    = [...thresholds].sort((a, b) => b.roi - a.roi)[0]
  const currentThresh = thresholds.find(t => t.threshold_cents === 5)
  if (bestThresh && currentThresh && bestThresh.threshold_cents !== 5) {
    const dir = bestThresh.threshold_cents > 5 ? 'Raising' : 'Lowering'
    model_notes.push({
      level: bestThresh.roi > currentThresh.roi + 0.02 ? 'warn' : 'info',
      text: `${dir} the edge threshold to ${bestThresh.threshold_cents}¢ would improve ROI from ${(currentThresh.roi*100).toFixed(1)}% → ${(bestThresh.roi*100).toFixed(1)}% (${bestThresh.bets} bets).`,
    })
  }
  const lowEdge   = calibration.find(c => c.bucket_cents === 5)
  const highEdge  = calibration.filter(c => c.bucket_cents >= 15)
  const highEdgeWR = highEdge.length
    ? highEdge.reduce((s,c) => s + c.wins, 0) / highEdge.reduce((s,c) => s + c.wins + c.losses, 0)
    : null
  if (lowEdge && lowEdge.win_rate < 0.45 && lowEdge.bets >= 5) {
    model_notes.push({ level: 'warn', text: `5¢ edge bets are only winning ${Math.round(lowEdge.win_rate*100)}% — close to break-even. These may not be real edge; consider a 7–8¢ floor.` })
  }
  if (highEdgeWR != null && highEdgeWR >= 0.75) {
    const totalHigh = highEdge.reduce((s,c) => s + c.bets, 0)
    model_notes.push({ level: 'good', text: `Bets with 15¢+ edge are winning at ${Math.round(highEdgeWR*100)}% (${totalHigh} bets). The model finds real edge at higher confidence levels.` })
  }
  const skipList = lambda_accuracy.filter(p => p.lambda_err >= 2 && p.win_rate <= 0.35 && p.bets >= 3)
  if (skipList.length) {
    model_notes.push({ level: 'warn', text: `Pitchers to consider skipping (over-predicted λ + losing record): ${skipList.map(p => p.pitcher).join(', ')}.` })
  }

  res.json({ calibration, lambda_accuracy, thresholds, model_notes })
}))

// ── Item 1: CLV (Closing Line Value) ─────────────────────────────────────────
router.get('/ks/clv', wrap(async (req, res) => {
  const uf = userFilter(req)
  const [bets, summary] = await Promise.all([
    db.all(
      `SELECT bet_date, pitcher_name, strike, side, fill_price,
              closing_line_cents, clv_cents, closing_line_captured_at, result, pnl
       FROM ks_bets
       WHERE clv_cents IS NOT NULL AND paper = 0 ${uf.clause}
       ORDER BY bet_date DESC, pitcher_name ASC, strike ASC
       LIMIT 200`,
      uf.args,
    ),
    db.one(
      `SELECT
         COUNT(*) AS total_with_clv,
         ROUND(AVG(clv_cents), 2) AS avg_clv,
         SUM(CASE WHEN clv_cents > 0 THEN 1 ELSE 0 END) AS beats_close,
         SUM(CASE WHEN clv_cents <= 0 THEN 1 ELSE 0 END) AS loses_close,
         ROUND(AVG(CASE WHEN result='win' THEN clv_cents END), 2) AS avg_clv_wins,
         ROUND(AVG(CASE WHEN result='loss' THEN clv_cents END), 2) AS avg_clv_losses
       FROM ks_bets
       WHERE clv_cents IS NOT NULL AND paper = 0 ${uf.clause}`,
      uf.args,
    ),
  ])
  res.json({
    bets: bets.map(r => ({ ...r, clv_cents: r.clv_cents != null ? roundTo(r.clv_cents, 1) : null })),
    summary: summary ?? {},
  })
}))

// ── Item 3: P&L by bet source ─────────────────────────────────────────────────
router.get('/ks/pnl-by-source', wrap(async (req, res) => {
  const uf = userFilter(req)
  const rows = await db.all(
    `SELECT
       CASE
         WHEN live_bet = 0 THEN 'pre_game'
         WHEN live_bet = 1 AND bet_mode IN ('pulled','blowout','dead-path','crossed-yes','pull-hedge') THEN 'structural'
         WHEN live_bet = 1 AND bet_mode = 'high-conviction' THEN 'probabilistic'
         ELSE 'live_other'
       END AS source,
       COUNT(*) AS bets,
       SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
       SUM(COALESCE(pnl, 0)) AS pnl,
       SUM(COALESCE(capital_at_risk, bet_size, 0)) AS wagered,
       AVG(CASE WHEN result IS NOT NULL THEN edge END) AS avg_edge
     FROM ks_bets
     WHERE result IN ('win','loss') AND paper = 0 ${uf.clause}
     GROUP BY source
     ORDER BY pnl DESC`,
    uf.args,
  )
  res.json(rows.map(r => {
    const wins    = Number(r.wins   || 0)
    const losses  = Number(r.losses || 0)
    const wagered = Number(r.wagered || 0)
    const pnl     = Number(r.pnl    || 0)
    return {
      source:   r.source,
      bets:     Number(r.bets || 0),
      wins, losses,
      win_rate: wins + losses > 0 ? roundTo(wins / (wins + losses), 4) : 0,
      pnl:      roundTo(pnl, 2),
      roi:      wagered > 0 ? roundTo(pnl / wagered, 4) : 0,
      avg_edge: r.avg_edge != null ? roundTo(r.avg_edge, 4) : null,
    }
  }))
}))

router.post('/ks/auto-settle', wrap(async (req, res) => {
  const { user_id } = req.body || {}
  const today  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const clause = user_id ? 'bet_date = ? AND result IS NULL AND paper = 0 AND user_id = ?' : 'bet_date = ? AND result IS NULL AND paper = 0'
  const args   = user_id ? [today, user_id] : [today]
  const pending = await db.all(`SELECT * FROM ks_bets WHERE ${clause}`, args)
  if (!pending.length) return res.json({ settled: 0, checked: 0 })

  const BASE       = 'https://api.elections.kalshi.com/trade-api/v2'
  const KALSHI_FEE = 0.07
  const now        = new Date().toISOString()
  let settled      = 0

  for (const bet of pending) {
    if (!bet.ticker) continue
    try {
      const path    = `/trade-api/v2/markets/${bet.ticker}`
      const headers = getAuthHeaders('GET', path)
      const r = await axios({ method: 'GET', url: BASE + `/markets/${bet.ticker}`, headers, timeout: 8000 })
      const m = r.data?.market
      if (!m || m.status !== 'finalized' || !m.result) continue
      const actualKs   = m.expiration_value != null ? Number(m.expiration_value) : null
      const won        = (bet.side === 'YES' && m.result === 'yes') || (bet.side === 'NO' && m.result === 'no')
      const spread     = bet.spread ?? 4
      const halfSpread = spread / 2 / 100
      const mid        = bet.market_mid != null ? bet.market_mid / 100 : (bet.model_prob ?? 0.5)
      const fillFrac   = bet.side === 'YES' ? mid + halfSpread : (1 - mid) + halfSpread
      const pnl        = won
        ? bet.bet_size * (1 - fillFrac) * (1 - KALSHI_FEE)
        : -bet.bet_size * fillFrac
      await db.run(
        `UPDATE ks_bets SET actual_ks=?, result=?, settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
        [actualKs, won ? 'win' : 'loss', now, Math.round(pnl * 100) / 100, bet.id],
      )
      settled++
    } catch (e) {
      console.error(`[auto-settle] ${bet.ticker}:`, e.message)
    }
  }

  res.json({ settled, checked: pending.length })
}))

// ── System Feed helpers ──────────────────────────────────────────────────────

function _translateLiveLog(row) {
  const { tag, msg = '', pitcher: p = '', strike, side: sd = '', edge_cents, pnl } = row
  const s = strike ? `${strike}+` : ''
  const isFM = msg.includes('[FREE MONEY]')

  const contractsM = msg.match(/(\d+)c @/)
  const priceM     = msg.match(/@ ([\d.]+)¢/)
  const filledM    = msg.match(/filled[=](\d+)/)
  const profitM    = msg.match(/profit≈\+\$([\d.]+)/)

  const contracts = contractsM ? parseInt(contractsM[1]) : null
  const price     = priceM     ? parseFloat(priceM[1])   : null
  const filled    = filledM    ? parseInt(filledM[1])     : null
  const profit    = profitM    ? parseFloat(profitM[1])   : (pnl != null ? Math.abs(pnl) : null)

  if (tag === 'BET' && isFM) {
    const qty     = filled ?? contracts ?? '?'
    const costStr = (qty !== '?' && price) ? ` Risking $${(qty * price / 100).toFixed(2)}.` : ''
    return {
      category: 'free_money', badge: 'FREE MONEY',
      headline: `${p || 'Pitcher'} pulled — free money on ${s} ${sd} contracts`,
      detail: `${p} was removed from the game. The system immediately placed ${qty} ${sd} contracts at ${price != null ? price + '¢' : '?'} each. When a pitcher is pulled, NO-side strikeout bets become near-certain winners — the pitcher can't rack up more Ks.${costStr}${profit ? ' Expected profit: +$' + profit.toFixed(2) + '.' : ''}`,
      pitcher: p, pnl: profit,
    }
  }

  if (tag === 'BET') {
    const isMaker = msg.includes('(ask')
    const qty     = filled ?? contracts ?? '?'
    const edgeStr = edge_cents != null ? ` (${edge_cents.toFixed(1)}¢ edge)` : ''
    const riskAmt = (qty !== '?' && price) ? '$' + (qty * price / 100).toFixed(2) : null
    const sideDesc = sd === 'YES' ? `hit ${s} strikeouts` : `stay under ${s} strikeouts`
    return {
      category: 'bet_placed', badge: isMaker ? 'BET · MAKER' : 'BET · TAKER',
      headline: `${p || 'Pitcher'} — ${s} ${sd} live bet placed${edgeStr}`,
      detail: `Live ${isMaker ? 'maker' : 'taker'} bet on ${p || 'this pitcher'} to ${sideDesc}. ${qty} contracts at ${price != null ? price + '¢' : '?'}.${riskAmt ? ' Risk: ' + riskAmt + '.' : ''}${profit ? ' Expected profit: +$' + profit.toFixed(2) + '.' : ''}`,
      pitcher: p, pnl: profit,
    }
  }

  if (tag === 'COVER') {
    const ksM = msg.match(/at (\d+)K/)
    const ks  = ksM ? ksM[1] : null
    return {
      category: 'cover', badge: 'COVERED ✓',
      headline: `${p || 'Pitcher'} ${s} YES covered${ks ? ` — ${ks} strikeouts` : ''}`,
      detail: `${p || 'The pitcher'} crossed the ${s} strikeout threshold${ks ? ` with ${ks} Ks` : ''}. This YES bet is locked in as a winner.${pnl != null ? ' P&L: +$' + Math.abs(pnl).toFixed(2) + '.' : ''}`,
      pitcher: p, pnl,
    }
  }

  if (tag === 'DEAD') {
    const ksM = msg.match(/at (\d+)K/)
    const ks  = ksM ? ksM[1] : null
    return {
      category: 'dead', badge: 'PATH DEAD',
      headline: `${p || 'Pitcher'} ${s} YES can't be reached — bet lost`,
      detail: `${p || 'The pitcher'} was pulled${ks ? ` after ${ks} strikeouts` : ''}, short of the ${s} threshold. This YES bet is a loss.${pnl != null ? ' P&L: $' + pnl.toFixed(2) + '.' : ''}`,
      pitcher: p, pnl,
    }
  }

  if (tag === 'NO_LOST') {
    const ksM = msg.match(/at (\d+)K/)
    const ks  = ksM ? ksM[1] : null
    return {
      category: 'loss', badge: 'NO BLOWN',
      headline: `${p || 'Pitcher'} ${s} NO bet blown${ks ? ` — hit ${ks} Ks` : ''}`,
      detail: `${p || 'The pitcher'} crossed the ${s} strikeout mark${ks ? ` (${ks} Ks)` : ''}, so the NO bet on this threshold lost.${pnl != null ? ' P&L: $' + pnl.toFixed(2) + '.' : ''}`,
      pitcher: p, pnl,
    }
  }

  if (tag === 'SETTLED') {
    const wM = msg.match(/(\d+)W/), lM = msg.match(/(\d+)L/)
    const wins = wM ? parseInt(wM[1]) : 0, losses = lM ? parseInt(lM[1]) : 0
    const gameLabel = msg.split('  ')[0] || 'Game'
    const pnlStr    = pnl != null ? ' · ' + (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2) : ''
    return {
      category: pnl != null ? (pnl >= 0 ? 'win' : 'loss') : 'info', badge: 'GAME SETTLED',
      headline: `${gameLabel} settled — ${wins}W / ${losses}L${pnlStr}`,
      detail: `In-game bets for ${gameLabel} are finalized. Result: ${wins} win${wins !== 1 ? 's' : ''}, ${losses} loss${losses !== 1 ? 'es' : ''}.${pnl != null ? ' Net game P&L: ' + (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2) + '.' : ''}`,
      pnl,
    }
  }

  if (tag === 'SCRATCH') {
    return {
      category: 'skip', badge: 'SCRATCHED',
      headline: `${p || 'Pitcher'} scratched — never threw a pitch`,
      detail: `${p || 'This pitcher'} was confirmed as a scratch. Any pre-game bets on this pitcher have been voided and will be refunded by Kalshi.`,
      pitcher: p,
    }
  }

  if (tag === 'SELL') {
    const sellM = msg.match(/@ (\d+)¢/)
    return {
      category: 'info', badge: 'AUTO-CLOSE',
      headline: `${p || 'Pitcher'} ${s} YES position sold to lock in gains`,
      detail: `The system auto-sold the ${p} ${s}+ YES position${sellM ? ` at ${sellM[1]}¢` : ''} before game end to capture profit early.`,
      pitcher: p,
    }
  }

  if (tag === 'STARTUP') {
    const modeM = msg.match(/Mode=(LIVE|PAPER)/), pM = msg.match(/pitchers=(\d+)/), gM = msg.match(/games=(\d+)/), eM = msg.match(/edge≥(\d+)¢/)
    const mode = modeM ? modeM[1] : 'PAPER', pitchers = pM ? pM[1] : '?', games = gM ? gM[1] : '?', edge = eM ? eM[1] : '5'
    return {
      category: 'system', badge: mode === 'LIVE' ? '🔴 LIVE MODE' : '📄 PAPER',
      headline: `In-game monitor started — watching ${pitchers} pitcher${pitchers !== '1' ? 's' : ''} across ${games} game${games !== '1' ? 's' : ''}`,
      detail: `The live betting system came online in ${mode} mode. It will monitor K counts, pitch counts, and Kalshi market prices every 15–30 seconds and auto-bet when it finds an edge above ${edge}¢.`,
    }
  }

  if (tag === 'PULLED') {
    const modelM = msg.match(/model=([\d.]+)%/), midM = msg.match(/mid=(\d+)¢/), edgeM = msg.match(/edge=([\d.]+)¢/), ksM = msg.match(/(\d+)K /)
    return {
      category: 'pulled', badge: 'PULL SIGNAL',
      headline: `${p || 'Pitcher'} ${s} ${sd} — pulled pitcher opportunity being evaluated`,
      detail: `${p || 'A pitcher'} was detected as pulled${ksM ? ` (${ksM[1]} Ks so far)` : ''}. Evaluating free money on ${sd} side — model: ${modelM ? modelM[1] + '%' : '?'}, market mid: ${midM ? midM[1] + '¢' : '?'}, edge: ${edgeM ? edgeM[1] + '¢' : '?'}.`,
      pitcher: p,
    }
  }

  if (tag === 'EDGE') {
    const modelM = msg.match(/model=([\d.]+)%/), midM = msg.match(/mid=(\d+)¢/), edgeM = msg.match(/edge=([\d.]+)¢/), ksM = msg.match(/(\d+)K /)
    return {
      category: 'edge_found', badge: 'LIVE EDGE',
      headline: `${p || 'Pitcher'} ${s} ${sd} — live edge found (${edgeM ? edgeM[1] : edge_cents != null ? edge_cents.toFixed(1) : '?'}¢)`,
      detail: `Live model detected an in-game edge for ${p} ${s} ${sd}. Model probability: ${modelM ? modelM[1] + '%' : '?'}, market mid: ${midM ? midM[1] + '¢' : '?'}.${ksM ? ` Current Ks: ${ksM[1]}.` : ''}`,
      pitcher: p, edge_cents,
    }
  }

  if (tag === 'RULE_CHANGE') {
    const arrowM = msg.match(/(\d[\d.]*) → (\d[\d.]*)/)
    const labelM = msg.match(/Rule updated: (.+?) \d/)
    return {
      category: 'system', badge: '⚙ RULE CHANGED',
      headline: msg.replace(/^Rule updated: /, '').slice(0, 120),
      detail: `The calibration engine automatically updated a betting rule based on shadow analysis of banned bets. ${arrowM ? `Changed from ${arrowM[1]} → ${arrowM[2]}.` : ''} This takes effect on the next monitoring cycle.`,
    }
  }

  if (tag === 'RULE_CONFIRM') {
    return {
      category: 'system', badge: '✓ RULE CONFIRMED',
      headline: msg.replace(/^Rule confirmed: /, '').slice(0, 120),
      detail: `Shadow analysis confirmed this rule is performing as intended — no change needed.`,
    }
  }

  if (tag === 'RULE_WATCH') {
    return {
      category: 'system', badge: '👁 RULE WATCH',
      headline: msg.replace(/^Shadow analysis: /, 'Watching rule groups — ').slice(0, 120),
      detail: `Insufficient data to make a rule change yet. Continuing to accumulate shadow bet outcomes for analysis.`,
    }
  }

  if (tag === 'INFO') {
    return {
      category: 'system', badge: 'INFO',
      headline: msg.slice(0, 120),
      detail: '',
    }
  }

  if (tag === 'RETRY') {
    return {
      category: 'info', badge: 'RETRY',
      headline: `${p || 'Order'} ${s} ${sd} — order retried at more aggressive price`,
      detail: msg.slice(0, 200),
      pitcher: p,
    }
  }

  if (tag === 'ERROR') {
    return {
      category: 'error', badge: 'ERROR',
      headline: `System error${p ? ' — ' + p : ''}`,
      detail: (msg || 'An error occurred in the live monitor.').slice(0, 300),
      pitcher: p,
    }
  }

  return { category: 'info', badge: tag, headline: (msg || `Event: ${tag}`).slice(0, 120), detail: '' }
}

function _translatePipeline(row) {
  let pf = null, bets = null, edges = null, rules = null
  try { pf    = row.preflight_json    ? JSON.parse(row.preflight_json)    : null } catch {}
  try { bets  = row.bets_placed_json  ? JSON.parse(row.bets_placed_json)  : null } catch {}
  try { edges = row.edges_json        ? JSON.parse(row.edges_json)        : null } catch {}
  try { rules = row.rule_filters_json ? JSON.parse(row.rule_filters_json) : null } catch {}

  const pitcher  = row.pitcher_name   || 'Pitcher'
  const game     = row.game_label     || ''
  const lambda   = row.lambda         != null ? row.lambda.toFixed(1)            : '?'
  const conf     = row.confidence     || 'unknown'
  const bestEdge = row.best_edge      != null ? (row.best_edge * 100).toFixed(1) + '¢' : null
  const n_edges  = row.n_edges        || 0
  const n_bets   = row.n_bets_logged  || 0
  const n_mkts   = row.n_markets      || 0

  if (n_bets > 0) {
    const betsRows  = bets?.rows || []
    const totalRisk = bets?.total_risk_usd != null ? '$' + bets.total_risk_usd.toFixed(2) : '?'
    const boosted   = pf?.action === 'boost'
    const betSummary = betsRows.slice(0, 3).map(b => {
      const p = Math.round((b.fill ?? 0) * 100)
      return `${b.strike}+ ${b.side}${p ? ' @ ' + p + '¢' : ''}`
    }).join(', ')

    let kellyDetail = ''
    if (betsRows[0] && Array.isArray(edges)) {
      const me = edges.find(e => e.strike === betsRows[0].strike && e.passed)
      if (me) {
        const mp = Math.round((me.model_prob || 0) * 100)
        const kp = Math.round((me.mid || 0) * 100)
        const ec = ((me.best_edge || 0) * 100).toFixed(1)
        kellyDetail = ` Model gives ${mp}% probability vs market's ${kp}% — a ${ec}¢ edge. Quarter-Kelly sizing → ${totalRisk} total risk.`
      }
    }

    return {
      category: boosted ? 'boost' : 'bet_scheduled', badge: boosted ? 'PRE-GAME (BOOSTED)' : 'PRE-GAME BET',
      headline: `${pitcher} — ${n_bets} pre-game bet${n_bets !== 1 ? 's' : ''} placed, total risk ${totalRisk}`,
      detail: `Model predicts ${lambda} Ks for ${pitcher}${game ? ` (${game})` : ''} with ${conf} confidence. Placed bets: ${betSummary || n_bets + ' markets'}.${kellyDetail}${boosted && pf?.reason ? ' Boost reason: ' + pf.reason + '.' : ''}`,
      ts: row.updated_at,
    }
  }

  if (row.final_action === 'preflight_skip') {
    const reason    = pf?.reason || row.skip_reason || 'news or risk flagged'
    const headlines = (pf?.headlines || []).filter(h => h.signal !== 'neutral').slice(0, 1)
    const newsText  = headlines.length ? ` Key headline: "${headlines[0].text.slice(0, 100)}"` : ''
    return {
      category: 'skip', badge: 'SKIPPED',
      headline: `${pitcher} skipped — AI flagged a concern before betting`,
      detail: `The pre-flight AI news check blocked this bet. Reason: ${reason}.${newsText} Had ${n_edges} edge${n_edges !== 1 ? 's' : ''} but no orders were placed.`,
      ts: row.updated_at,
    }
  }

  if (row.final_action === 'filtered_out') {
    const rA = rules?.rule_a_drops?.length || 0
    const rD = rules?.rule_d_drops?.length || 0
    const names = []
    if (rA) names.push(`Rule A (${rA} low-probability NO bet${rA !== 1 ? 's' : ''} removed)`)
    if (rD) names.push(`Rule D (${rD} high-probability YES bet${rD !== 1 ? 's' : ''} removed)`)
    const ruleText = names.length ? names.join('; ') : 'internal rule filter'
    return {
      category: 'filtered', badge: 'RULE FILTER',
      headline: `${pitcher} — ${n_edges} edge${n_edges !== 1 ? 's' : ''} found but blocked by rules`,
      detail: `Model found ${n_edges} edge${n_edges !== 1 ? 's' : ''} for ${pitcher}${game ? ` (${game})` : ''}, best at ${bestEdge || '?'}, but removed by: ${ruleText}. These rules prevent bets where the risk/reward is unfavorable even with an edge.`,
      ts: row.updated_at,
    }
  }

  if (row.final_action === 'no_edge') {
    return {
      category: 'no_edge', badge: 'NO EDGE',
      headline: `${pitcher} — no profitable edge found across ${n_mkts} market${n_mkts !== 1 ? 's' : ''}`,
      detail: `Evaluated ${n_mkts} market${n_mkts !== 1 ? 's' : ''} for ${pitcher}${game ? ` (${game})` : ''}. Model predicts ${lambda} Ks (${conf} confidence). Best edge found: ${bestEdge || 'none'} — need at least 5¢ to place a bet. The market is fairly priced today.`,
      ts: row.updated_at,
    }
  }

  if (row.final_action === 'no_markets') {
    return {
      category: 'no_edge', badge: 'NO MARKETS',
      headline: `${pitcher} — no Kalshi strikeout contracts available yet`,
      detail: `${pitcher}${game ? ` (${game})` : ''} was evaluated but Kalshi hasn't listed any contracts for this pitcher. Markets typically open 2–4 hours before first pitch.`,
      ts: row.updated_at,
    }
  }

  if (row.final_action === 'error') {
    return {
      category: 'error', badge: 'ERROR',
      headline: `${pitcher} — pipeline error during evaluation`,
      detail: `Something went wrong evaluating ${pitcher}. The system will retry automatically on the next scan cycle. Reason: ${row.skip_reason || 'unknown'}.`,
      ts: row.updated_at,
    }
  }

  return {
    category: 'info', badge: 'EVALUATED',
    headline: `${pitcher} — ${n_edges} edge${n_edges !== 1 ? 's' : ''} found (${row.final_action || 'processing'})`,
    detail: `Model predicts ${lambda} Ks for ${pitcher}. Status: ${row.final_action || 'processing'}.`,
    ts: row.updated_at,
  }
}

// GET /ks/feed — real-time system event feed for Pipeline tab
router.get('/ks/feed', wrap(async (req, res) => {
  const date  = req.query.date || todayISO()
  const limit = Math.min(parseInt(req.query.limit || '150', 10), 300)

  const [liveRows, pipeRows] = await Promise.all([
    db.all(
      `SELECT id, ts, tag, msg, pitcher, strike, side, edge_cents, pnl
       FROM live_log WHERE bet_date=? ORDER BY ts DESC LIMIT 120`,
      [date],
    ).catch(() => []),
    db.all(
      `SELECT pitcher_name, game_label, game_time, final_action,
              n_markets, n_edges, n_bets_logged, best_edge, lambda, confidence,
              skip_reason, preflight_json, bets_placed_json, rule_filters_json, edges_json,
              updated_at, created_at
       FROM decision_pipeline WHERE bet_date=? ORDER BY updated_at DESC`,
      [date],
    ).catch(() => []),
  ])

  const events = []

  for (const row of liveRows) {
    const ev = _translateLiveLog(row)
    events.push({ id: `ll_${row.id}`, ts: row.ts, source: 'live', ...ev })
  }

  for (const row of pipeRows) {
    const ev = _translatePipeline(row)
    events.push({ id: `dp_${row.pitcher_name}_${(row.updated_at || '').replace(/\W/g, '')}`, ts: row.updated_at || row.created_at, source: 'pipeline', ...ev })
  }

  events.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))

  res.json({ date, events: events.slice(0, limit) })
}))

// Balance adjustments — record deposits/withdrawals so the balance-delta P&L
// calculation doesn't mistake a mid-day deposit as a trading gain.
router.post('/ks/balance-adjustment', wrap(async (req, res) => {
  const { user_id, amount_usd, note } = req.body ?? {}
  if (!user_id || amount_usd == null || isNaN(Number(amount_usd))) {
    return res.status(400).json({ error: 'user_id and amount_usd required' })
  }
  await db.run(
    `INSERT INTO manual_balance_adjustments (user_id, amount_usd, note, created_at)
     VALUES (?, ?, ?, ?)`,
    [user_id, Number(amount_usd), note ?? null, new Date().toISOString()],
  )
  res.json({ ok: true })
}))

router.get('/ks/balance-adjustments', wrap(async (req, res) => {
  const date = req.query.date || todayISO()
  const rows = await db.all(
    `SELECT id, user_id, amount_usd, note, created_at FROM manual_balance_adjustments
     WHERE created_at >= ? AND created_at < ?
     ORDER BY created_at DESC`,
    [date + 'T00:00:00.000Z', date + 'T23:59:59.999Z'],
  )
  res.json({ date, adjustments: rows })
}))

// GET /ks/contra-test — status of the NO contra-test experiment.
// See memory: project_baseball_contra_test_apr29.md  Decision date: 2026-05-20.
router.get('/ks/contra-test', wrap(async (req, res) => {
  const DECISION_DATE = '2026-05-20'
  const summary = await db.one(`
    SELECT COUNT(*) AS bets,
           SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
           SUM(CASE WHEN result IS NULL THEN 1 ELSE 0 END) AS pending,
           ROUND(SUM(pnl), 2) AS total_pnl,
           ROUND(SUM(capital_at_risk), 2) AS total_risk,
           MIN(bet_date) AS started,
           MAX(bet_date) AS latest
    FROM ks_bets
    WHERE bet_mode = 'contra-test' AND user_id = 2
  `).catch(() => null)
  const recent = await db.all(`
    SELECT bet_date, pitcher_name, strike, fill_price, capital_at_risk,
           actual_ks, result, pnl
    FROM ks_bets
    WHERE bet_mode = 'contra-test' AND user_id = 2
    ORDER BY id DESC LIMIT 10
  `).catch(() => [])
  const today = todayISO()
  const decisionMs = Date.parse(DECISION_DATE + 'T09:00:00-04:00')
  const daysToDecision = Math.max(0, Math.ceil((decisionMs - Date.now()) / 86400000))
  const totalRisk = Number(summary?.total_risk || 0)
  const totalPnl  = Number(summary?.total_pnl  || 0)
  const roi_pct   = totalRisk > 0 ? Math.round((totalPnl / totalRisk) * 1000) / 10 : null
  res.json({
    decision_date: DECISION_DATE,
    days_to_decision: daysToDecision,
    success_threshold_roi: 3.0,  // graduate if ≥3% over 50+ bets
    bets:    Number(summary?.bets || 0),
    wins:    Number(summary?.wins || 0),
    losses:  Number(summary?.losses || 0),
    pending: Number(summary?.pending || 0),
    total_pnl: totalPnl,
    total_risk: totalRisk,
    roi_pct,
    started: summary?.started ?? null,
    latest:  summary?.latest  ?? null,
    recent,
    sufficient_sample: Number(summary?.bets || 0) >= 50,
  })
}))

// GET /ks/fade-test — IDEAL fade model paper test status (started 2026-05-07)
router.get('/ks/fade-test', wrap(async (req, res) => {
  const TEST_START = '2026-05-07'
  const STARTING_BANKROLL = 5000
  // v3 filter: K=6 OR K>=10, with H-H (ipL5>=5) and H-I (confidence>0.3) requirements.
  // Pre-May-11 fires that pass this filter retroactively count as v3 results.
  const V3_FILTER = `
    AND (b.strike = 6 OR b.strike >= 10)
    AND (p.avg_innings_l5 IS NULL OR p.avg_innings_l5 >= 5.0)
    AND (p.confidence IS NULL OR p.confidence > 0.3)
  `
  const summary = await db.one(`
    SELECT
      COUNT(*) AS fires,
      SUM(CASE WHEN b.result='win'  THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN b.result='loss' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN b.result IS NULL OR b.result='pending' THEN 1 ELSE 0 END) AS pending,
      ROUND(SUM(CASE WHEN b.result IN ('win','loss') THEN b.pnl ELSE 0 END), 2) AS total_pnl,
      ROUND(SUM(CASE WHEN b.result IN ('win','loss') THEN b.filled_contracts * b.fill_price / 100.0 ELSE 0 END), 2) AS total_stake
    FROM ks_bets b
    LEFT JOIN pitcher_signals p ON p.pitcher_id = b.pitcher_id AND p.signal_date = b.bet_date
    WHERE b.strategy_mode = 'pregame_fade_yes' AND b.bet_date >= ?
    ${V3_FILTER}
  `, [TEST_START]).catch(() => null)
  const recent = await db.all(`
    SELECT b.bet_date, b.pitcher_name, b.strike, b.fill_price, b.filled_contracts,
           b.model_prob, b.edge, b.result, b.pnl, b.actual_ks
    FROM ks_bets b
    LEFT JOIN pitcher_signals p ON p.pitcher_id = b.pitcher_id AND p.signal_date = b.bet_date
    WHERE b.strategy_mode = 'pregame_fade_yes' AND b.bet_date >= ?
    ${V3_FILTER}
    ORDER BY b.id DESC LIMIT 25
  `, [TEST_START]).catch(() => [])
  const dailyPnl = await db.all(`
    SELECT b.bet_date,
           COUNT(*) AS n,
           SUM(CASE WHEN b.result='win' THEN 1 ELSE 0 END) AS w,
           ROUND(SUM(CASE WHEN b.result IN ('win','loss') THEN b.pnl ELSE 0 END), 2) AS pnl
    FROM ks_bets b
    LEFT JOIN pitcher_signals p ON p.pitcher_id = b.pitcher_id AND p.signal_date = b.bet_date
    WHERE b.strategy_mode='pregame_fade_yes' AND b.bet_date >= ?
    ${V3_FILTER}
    GROUP BY b.bet_date ORDER BY b.bet_date
  `, [TEST_START]).catch(() => [])

  const fires = Number(summary?.fires || 0)
  const wins  = Number(summary?.wins  || 0)
  const losses = Number(summary?.losses || 0)
  const settled = wins + losses
  const totalPnl = Number(summary?.total_pnl || 0)
  const totalStake = Number(summary?.total_stake || 0)
  const winPct = settled > 0 ? Math.round((wins / settled) * 1000) / 10 : null
  const roi = totalStake > 0 ? Math.round((totalPnl / totalStake) * 1000) / 10 : null
  const bankroll = STARTING_BANKROLL + totalPnl

  // Compute peak/drawdown from running daily P&L
  let peak = STARTING_BANKROLL, maxDD = 0, runningBank = STARTING_BANKROLL
  for (const d of dailyPnl) {
    runningBank += Number(d.pnl || 0)
    if (runningBank > peak) peak = runningBank
    const dd = (peak - runningBank) / peak
    if (dd > maxDD) maxDD = dd
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const dayCount = Math.max(0, Math.floor((Date.parse(today) - Date.parse(TEST_START)) / 86400000) + 1)
  const milestone = dayCount < 7 ? 'pre-Day-7' :
                    dayCount < 14 ? 'Day-7→Day-14' :
                    dayCount < 30 ? 'Day-14→Day-30' : 'Day-30+'

  res.json({
    test_start: TEST_START,
    day_count: dayCount,
    milestone,
    starting_bankroll: STARTING_BANKROLL,
    bankroll,
    return_pct: Math.round((bankroll / STARTING_BANKROLL - 1) * 1000) / 10,
    fires, wins, losses, pending: Number(summary?.pending || 0),
    settled,
    win_pct: winPct,
    roi_pct: roi,
    total_pnl: totalPnl,
    total_stake: totalStake,
    max_drawdown_pct: Math.round(maxDD * 1000) / 10,
    daily: dailyPnl,
    recent,
    backtest_target_roi: 60,  // ~50% of +127% test backtest after deflation
    milestone_days: { sanity: 7, decision: 14, confidence: 30 },
  })
}))

export default router
