// lib/marketSnapshotWriter.js — fire-and-forget market snapshot persistence.
// Called every ~10-min edge check tick. Writes one row per evaluated market.
// Never throws into the caller — all errors are caught and logged internally.

import * as db from './db.js'

const CHUNK = 100  // max rows per INSERT

export function buildSnapshotRow({
  ticker, pitcherId, pitcherName, strike, gameDate, capturedAt,
  gameId, gameLabel, gameStatus,
  yesBidCents, yesAskCents, midCents, openInterest, volume,
  yesAskSize, yesBidSize,
  modelProb, edgeYes, edgeNo, bestSide, bestEdge, kellyFraction,
  evalMode, qualified, rejectReason,
  liveKs, liveIp, liveBf, livePitches, stillIn, currentInning,
  homeScore, awayScore,
}) {
  const midC  = midCents  ?? null
  const bidC  = yesBidCents ?? null
  const askC  = yesAskCents ?? null
  return {
    captured_at:   capturedAt,
    game_date:     gameDate,
    ticker,
    pitcher_id:    pitcherId  ?? null,
    pitcher_name:  pitcherName,
    game_id:       gameId     ?? null,
    game_label:    gameLabel  ?? null,
    strike,
    yes_bid:       bidC,
    yes_ask:       askC,
    no_bid:        bidC  != null ? 100 - askC : null,
    no_ask:        askC  != null ? 100 - bidC : null,
    yes_price:     midC,
    no_price:      midC  != null ? 100 - midC : null,
    spread:        (askC != null && bidC != null) ? askC - bidC : null,
    open_interest: openInterest ?? null,
    volume:        volume       ?? null,
    yes_ask_size:  yesAskSize  ?? null,
    yes_bid_size:  yesBidSize  ?? null,
    model_prob:    modelProb,
    edge_yes:      edgeYes     ?? null,
    edge_no:       edgeNo      ?? null,
    best_side:     bestSide    ?? null,
    best_edge:     bestEdge    ?? null,
    kelly_fraction: kellyFraction ?? null,
    game_status:   gameStatus  ?? null,
    live_inning:   currentInning ?? null,
    live_ks:       liveKs      ?? null,
    live_ip:       liveIp      ?? null,
    live_bf:       liveBf      ?? null,
    live_pitches:  livePitches ?? null,
    still_in:      stillIn     != null ? (stillIn ? 1 : 0) : null,
    home_score:    homeScore   ?? null,
    away_score:    awayScore   ?? null,
    eval_mode:     evalMode    ?? null,
    qualified:     qualified   ? 1 : 0,
    reject_reason: rejectReason ?? null,
  }
}

export async function writeSnapshotBatch(rows) {
  if (!rows?.length) return
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const cols  = Object.keys(chunk[0])
    const placeholders = `(${cols.map(() => '?').join(',')})`
    const sql = `INSERT OR IGNORE INTO market_snapshots (${cols.join(',')}) VALUES ${chunk.map(() => placeholders).join(',')}`
    const vals = chunk.flatMap(r => cols.map(c => r[c]))
    await db.run(sql, vals).catch(err =>
      db.saveLog({ tag: 'SNAPSHOT_ERR', level: 'error', msg: `batch write: ${err.message}` }).catch(() => {})
    )
  }
}

export async function linkBetToSnapshot(betId, ticker, capturedAt) {
  if (!betId || !ticker || !capturedAt) return
  const res = await db.run(
    `UPDATE market_snapshots SET bet_id = ? WHERE ticker = ? AND captured_at = ? AND bet_id IS NULL`,
    [betId, ticker, capturedAt],
  ).catch(() => null)
  // Retry once after 600ms if row wasn't committed yet when bet fired
  if (!res || !res.rowsAffected) {
    await new Promise(r => setTimeout(r, 600))
    await db.run(
      `UPDATE market_snapshots SET bet_id = ? WHERE ticker = ? AND captured_at = ? AND bet_id IS NULL`,
      [betId, ticker, capturedAt],
    ).catch(() => {})
  }
}

export async function backfillOutcome({ pitcherId, gameDate, actualKs }) {
  if (pitcherId == null || !gameDate || actualKs == null) return
  await db.run(
    `UPDATE market_snapshots SET actual_ks = ?, resolved_at = datetime('now')
     WHERE pitcher_id = ? AND game_date = ? AND actual_ks IS NULL`,
    [actualKs, String(pitcherId), gameDate],
  ).catch(() => {})
}
