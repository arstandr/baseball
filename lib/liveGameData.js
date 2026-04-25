// Shared MLB live data fetcher — read-only, no settlement writes.
// Used by both the /ks/live route (which adds settlement writes) and the SSE
// heartbeat (which broadcasts live_update events to all connected clients).

import * as db from './db.js'

let _mlbFetch, _extractStarter
try {
  const m = await import('./mlb-live.js')
  _mlbFetch = m.mlbFetch
  _extractStarter = m.extractStarterFromBoxscore
} catch {}

export function mlbAvailable() { return !!_mlbFetch }

export async function fetchLivePitcherData(date) {
  if (!_mlbFetch) return []

  const allBets = await db.all(
    `SELECT id, pitcher_id, pitcher_name, strike, side, result
     FROM ks_bets
     WHERE bet_date = ? AND live_bet = 0 AND paper = 0
       AND result IS NOT 'void'`,
    [date],
  )
  if (!allBets.length) return []

  const pitcherIds = new Set(allBets.map(b => String(b.pitcher_id)).filter(Boolean))

  const sched = await _mlbFetch(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,probablePitcher`,
  ).catch(() => null)
  const games = sched?.dates?.[0]?.games || []

  // Emit postponed/suspended games immediately — no boxscore needed
  const results = []
  const previewGames = []
  for (const g of games) {
    const status = g.status?.abstractGameState
    const detail = g.status?.detailedState || ''
    const isPostponed = status === 'Preview' &&
      /postponed|suspended|cancelled|canceled/i.test(detail)

    if (isPostponed) {
      for (const side of ['away', 'home']) {
        const prob = g.teams?.[side]?.probablePitcher
        if (!prob || !pitcherIds.has(String(prob.id))) continue
        const away = g.teams?.away?.team?.abbreviation || 'AWAY'
        const home = g.teams?.home?.team?.abbreviation || 'HOME'
        const myBets = allBets.filter(b => String(b.pitcher_id) === String(prob.id))
        results.push({
          pitcher_id:   String(prob.id),
          pitcher_name: prob.fullName || prob.initLastName || String(prob.id),
          ks: 0, ip: 0, bf: 0, pitches: 0,
          still_in: false, is_postponed: true,
          game:         `${away}@${home}`,
          game_status:  detail,
          inning:       detail,
          is_final:     false,
          home_score: null, away_score: null, inning_state: null, is_pitching: false,
          bet_statuses: myBets.map(b => ({
            id: b.id, strike: b.strike, side: b.side,
            result: b.result ?? null, ks: 0, needed: b.strike,
          })),
        })
      }
      continue
    }

    if (status === 'Preview') {
      const awayProb = String(g.teams?.away?.probablePitcher?.id || '')
      const homeProb = String(g.teams?.home?.probablePitcher?.id || '')
      if (pitcherIds.has(awayProb) || pitcherIds.has(homeProb)) previewGames.push(g)
    } else {
      previewGames.push(g)
    }
  }

  const gamesToFetch = previewGames

  const boxscores = await Promise.all(
    gamesToFetch.map(g =>
      _mlbFetch(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`).catch(() => null),
    ),
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

    for (const side of ['home', 'away']) {
      const starter = _extractStarter(bs, side)
      if (!starter || !pitcherIds.has(starter.id)) continue

      const myBets = allBets.filter(b => String(b.pitcher_id) === starter.id)
      const isPitching = !isFinal && !!starter.still_in &&
        (side === 'home' ? ls?.inningState === 'Top' : ls?.inningState === 'Bottom')

      results.push({
        pitcher_id:   starter.id,
        pitcher_name: starter.name,
        ks:           starter.ks,
        ip:           parseFloat(starter.ip.toFixed(1)),
        bf:           starter.bf,
        pitches:      starter.pitches,
        still_in:     starter.still_in,
        game:         `${away}@${home}`,
        game_status:  detail,
        inning,
        is_final:     isFinal,
        home_score:   ls?.teams?.home?.runs ?? null,
        away_score:   ls?.teams?.away?.runs ?? null,
        inning_state: ls?.inningState ?? null,
        is_pitching:  isPitching,
        // Current at-bat count — only meaningful when pitcher is actively pitching
        balls:        isPitching ? (ls?.balls   ?? null) : null,
        strikes:      isPitching ? (ls?.strikes ?? null) : null,
        outs:         isPitching ? (ls?.outs    ?? null) : null,
        bet_statuses: myBets.map(b => ({
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
  // For betted pitchers whose game is still Preview (not started), emit a cleared
  // entry so any stale liveOverlay data on connected clients gets overwritten.
  // Without this, a blip from the MLB API (e.g. brief "Live" state before first pitch)
  // can leave is_pitching=true/inning='1st' stuck in the overlay indefinitely.
  const resultIds = new Set(results.map(r => r.pitcher_id))
  for (const pid of pitcherIds) {
    if (resultIds.has(pid)) continue
    const bet = allBets.find(b => String(b.pitcher_id) === pid)
    if (!bet) continue
    results.push({
      pitcher_id:   pid,
      pitcher_name: bet.pitcher_name,
      ks: 0, ip: 0, bf: 0, pitches: 0,
      still_in: null, is_final: false, is_postponed: false,
      game: null, game_status: 'pre-game',
      inning: null, inning_state: null, is_pitching: false,
      home_score: null, away_score: null,
      bet_statuses: allBets.filter(b => String(b.pitcher_id) === pid).map(b => ({
        id: b.id, strike: b.strike, side: b.side, result: b.result ?? null, ks: 0, needed: b.strike,
      })),
    })
  }

  return results
}
