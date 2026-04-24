import { state, shared } from '../state.js'
import { fmt$, esc, fmtDatePill, fmtDateFull, fmtGameTime, fmtTs, renderSparkline,
         calcBetFinancials, liveCoverProb, poissonCDF, probAtLeast, remainingLambda } from '../utils.js'
import { fetchJson } from '../api.js'
import { renderTicker } from '../ticker.js'

// ── Live polling timers ──────────────────────────────────────────────────

export function startLivePolling(date) {
  stopLivePolling()
  // Notify live.js via DOM event — avoids circular import
  document.dispatchEvent(new CustomEvent('ks:start-live', { detail: { date } }))
  state.liveTimer = setInterval(() => {
    document.dispatchEvent(new CustomEvent('ks:poll-tick', { detail: { date } }))
  }, 20_000)
}

export function stopLivePolling() {
  if (state.liveTimer)     { clearInterval(state.liveTimer);     state.liveTimer     = null }
  if (state.countdownTimer){ clearInterval(state.countdownTimer); state.countdownTimer = null }
}

export function startCountdowns() {
  updateCountdowns()
  if (state.countdownTimer) clearInterval(state.countdownTimer)
  state.countdownTimer = setInterval(updateCountdowns, 30_000)
}

function updateCountdowns() {
  document.querySelectorAll('.pc-countdown[data-game-time]').forEach(el => {
    const diff = new Date(el.dataset.gameTime) - Date.now()
    if (diff <= 0) { el.textContent = ''; el.hidden = true; return }
    el.hidden = false
    const totalMin = Math.floor(diff / 60000)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    el.textContent = h > 0 ? `· ${h}h ${m}m` : `· ${m}m`
  })
}

// ── Game status helpers ──────────────────────────────────────────────────

const GC_STATUS_CFG = {
  locked_win:   { label: '✅ Locked Win',   cls: 'gc-s-win'   },
  locked_loss:  { label: '❌ Locked Loss',  cls: 'gc-s-loss'  },
  locked_even:  { label: '— Finished Even', cls: 'gc-s-even'  },
  waiting:      { label: '⏳ Waiting',       cls: 'gc-s-wait'  },
  mostly_won:   { label: '🟢 Mostly Won',   cls: 'gc-s-great' },
  looking_good: { label: '🟢 Looking Good', cls: 'gc-s-good'  },
  in_play:      { label: '🟡 In Play',      cls: 'gc-s-play'  },
  at_risk:      { label: '🟠 At Risk',      cls: 'gc-s-risk'  },
  likely_loss:  { label: '🔴 Likely Loss',  cls: 'gc-s-bad'   },
}

function calcPitcherStatus(p, live) {
  const enriched = (p.bets || []).map(b => {
    const { winProfit, cost } = calcBetFinancials(b)
    const prob = liveCoverProb(b, live)
    let ts
    if      (b.result === 'win')  ts = 'locked_win'
    else if (b.result === 'loss') ts = 'locked_loss'
    else if (!live)               ts = 'waiting'
    else if (prob > 0.75)         ts = 'strong'
    else if (prob >= 0.40)        ts = 'in_play'
    else                          ts = 'unlikely'
    return { ...b, winProfit, cost, prob, thresholdStatus: ts }
  })

  const settled       = enriched.filter(b => b.result)
  const pending       = enriched.filter(b => !b.result)
  const netLocked     = settled.reduce((s, b) => s + (b.pnl ?? 0), 0)
  const pendingUpside = pending.reduce((s, b) => s + b.winProfit, 0)
  const pendingRisk   = pending.reduce((s, b) => s + b.cost, 0)
  const pendingEV     = pending.reduce((s, b) => s + b.winProfit * b.prob - b.cost * (1 - b.prob), 0)
  const totalBestCase = netLocked + pendingUpside
  const worstCase     = netLocked - pendingRisk
  const lockedRatio   = totalBestCase > 0.01 ? netLocked / totalBestCase : 0

  const pulled      = live?.still_in === false
  const gameFinal   = live?.is_final === true
  const allSettled  = pending.length === 0
  const hasLiveData = live != null && (live.ip > 0 || (live.ks != null && live.ks > 0))
  const earlyGame   = hasLiveData && (live.ip ?? 0) < 1.0

  let status
  if (pulled || gameFinal || allSettled) {
    status = netLocked > 0.01 ? 'locked_win' : netLocked < -0.01 ? 'locked_loss' : 'locked_even'
  } else if (!hasLiveData || earlyGame) {
    status = 'waiting'
  } else if (lockedRatio >= 0.70 && netLocked > 0) {
    status = 'mostly_won'
  } else if ((netLocked + pendingEV) > pendingRisk * 0.25) {
    status = 'looking_good'
  } else if (Math.abs(netLocked + pendingEV) < pendingRisk * 0.15) {
    status = 'in_play'
  } else if ((netLocked + pendingEV) > -pendingRisk * 0.5) {
    status = 'at_risk'
  } else {
    status = 'likely_loss'
  }

  const ks = live?.ks ?? null
  const wins   = settled.filter(b => b.result === 'win').length
  const losses = settled.filter(b => b.result === 'loss').length
  const pendingYesBets = pending.filter(b => b.side === 'YES').sort((a, b) => a.strike - b.strike)
  const pendingNoBets  = pending.filter(b => b.side === 'NO')
  const nextYes = pendingYesBets[0]
  const allYesBets = enriched.filter(b => b.side === 'YES').sort((a, b) => a.strike - b.strike)
  const lowestYesStrike = allYesBets[0]?.strike

  let projectedRange = null
  const yesByProb = [...pendingYesBets].sort((a, b) => a.strike - b.strike)
  if (yesByProb.length >= 1) {
    const above50 = yesByProb.filter(b => (b.model_prob ?? b.prob) >= 0.5)
    const below50 = yesByProb.filter(b => (b.model_prob ?? b.prob) < 0.5)
    if (above50.length && below50.length) {
      projectedRange = `${above50[above50.length - 1].strike}–${below50[0].strike}`
    } else if (above50.length) {
      projectedRange = `${above50[above50.length - 1].strike}+`
    } else if (below50.length) {
      projectedRange = `under ${below50[0].strike}`
    }
  }

  // gameFinal/allSettled checked before pulled: "Got pulled" only for mid-game removals, not finished games.
  let storySentence
  if (gameFinal || allSettled) {
    const fk = ks ?? p.actual_ks
    if (wins > 0 && losses === 0 && pending.length === 0) {
      storySentence = `Finished with ${fk ?? '?'} Ks — every bet hit.`
    } else if (losses > 0 && wins === 0 && pending.length === 0 && lowestYesStrike != null) {
      storySentence = `Finished with ${fk ?? '?'} Ks — needed ${lowestYesStrike}+ but fell short.`
    } else if (wins > 0 && losses > 0) {
      storySentence = `Finished with ${fk ?? '?'} Ks — ${wins} won, ${losses} lost.`
    } else {
      storySentence = `Game over — ${fk ?? '?'} strikeout${fk !== 1 ? 's' : ''}.`
    }
  } else if (pulled) {
    const target = lowestYesStrike ?? '?'
    storySentence = netLocked > 0.01
      ? `Got pulled after ${ks ?? '?'} Ks — key bets already locked in.`
      : `Got pulled after ${ks ?? '?'} Ks without reaching the ${target}+ target.`
  } else if (!hasLiveData || earlyGame) {
    if (nextYes) {
      const proj = projectedRange ? ` Model projects ~${projectedRange} Ks.` : ''
      storySentence = `Needs ${nextYes.strike}+ strikeouts. Game hasn't started yet.${proj}`
    } else if (pendingNoBets.length) {
      storySentence = `Betting he stays under ${pendingNoBets[0].strike} Ks. Game hasn't started yet.`
    } else {
      storySentence = `Game hasn't started yet.`
    }
  } else {
    if (nextYes) {
      const need = nextYes.strike - (ks ?? 0)
      if (need <= 0) {
        const nextNext = pendingYesBets[1]
        storySentence = nextNext
          ? `${nextYes.strike}+ covered — now needs ${nextNext.strike - (ks ?? 0)} more for ${nextNext.strike}+.`
          : `${nextYes.strike}+ covered — waiting on the game to end.`
      } else if (need === 1) {
        storySentence = `At ${ks ?? '?'} Ks — needs just 1 more for the ${nextYes.strike}+ target.`
      } else {
        storySentence = `At ${ks ?? '?'} Ks — needs ${need} more for the ${nextYes.strike}+ target.`
      }
    } else if (pendingNoBets.length) {
      const no = pendingNoBets[0]
      const safe = no.strike - (ks ?? 0)
      storySentence = `At ${ks ?? '?'} Ks — needs to stay under ${no.strike}+ (${safe} away from limit).`
    } else {
      storySentence = wins > 0
        ? `All targets hit — waiting for the game to end.`
        : `Game in progress — ${ks ?? '?'} Ks so far.`
    }
    if (wins > 0) storySentence += ` ${wins} bet${wins > 1 ? 's' : ''} already locked in.`
    if (losses > 0) storySentence += ` ${losses} bet${losses > 1 ? 's' : ''} already lost.`
  }

  let whatNeeds = null
  if (!gameFinal && !pulled && !allSettled && pending.length > 0) {
    if (nextYes) {
      const need = Math.max(0, nextYes.strike - (ks ?? 0))
      whatNeeds = need === 0 ? `${nextYes.strike}+ already covered` : `Needs ${need} more K${need > 1 ? 's' : ''} for ${nextYes.strike}+`
    } else if (pendingNoBets.length) {
      whatNeeds = `Must stay under ${pendingNoBets[0].strike} Ks`
    }
  }

  let situationLine = null
  if (live?.ip > 0 || live?.is_final || live?.still_in === false) {
    const parts = []
    if (ks != null)         parts.push(`${ks} Ks`)
    if (live.ip != null)    parts.push(`${Number(live.ip).toFixed(1)} IP`)
    if (live.pitches)       parts.push(`${live.pitches} pitches`)
    if (live.inning)        parts.push(live.inning)
    if (live.home_score != null) parts.push(`Score: ${live.away_score ?? '?'}–${live.home_score}`)
    situationLine = parts.join(' · ')
  }

  const nextBet      = nextYes
  const progressNum  = ks ?? 0
  const progressDen  = nextBet?.strike ?? null
  const progressPct  = progressDen > 0 ? Math.min(100, Math.round(progressNum / progressDen * 100)) : null
  const isLive       = hasLiveData && !gameFinal && !pulled && !allSettled
  const isFinished   = gameFinal || pulled || allSettled

  return {
    status, storySentence, whatNeeds, situationLine, projectedRange,
    enrichedBets: enriched,
    netLocked, pendingUpside, pendingRisk, pendingEV,
    totalBestCase, worstCase, lockedRatio,
    progressNum, progressDen, progressPct, nextBetProb: nextBet?.prob,
    isLive, isFinished, isWaiting: !isLive && !isFinished,
  }
}

export function computeMaxTheoretical(pitchers) {
  const FEE = 0.07
  let total = 0
  for (const p of pitchers) {
    const live       = shared.liveOverlay[String(p.pitcher_id)] || {}
    const determined = live.is_final === true || live.still_in === false
    const currentKs  = live.ks
    for (const b of p.bets) {
      if (b.result === 'win' || b.result === 'loss') {
        total += b.pnl ?? 0
        continue
      }
      const hasFill = b.filled_contracts > 0 && b.fill_price != null
      let winProfit
      if (hasFill) {
        const yesPriceFrac = b.fill_price / 100
        const winFrac = b.side === 'YES' ? (1 - yesPriceFrac) : yesPriceFrac
        winProfit = b.filled_contracts * winFrac * (1 - FEE)
      } else {
        const mid  = b.market_mid != null ? Number(b.market_mid) / 100 : 0.5
        const hs   = (b.spread ?? 4) / 200
        const fill = b.side === 'YES' ? mid + hs : (1 - mid) + hs
        const size = b.bet_size ?? 0
        winProfit = size * (1 - fill) * (1 - FEE)
      }
      if (determined && currentKs != null) {
        const won = b.side === 'YES' ? currentKs >= b.strike : currentKs < b.strike
        if (won) {
          total += winProfit
        } else {
          const cost = hasFill
            ? b.filled_contracts * (b.side === 'YES' ? b.fill_price : (100 - b.fill_price)) / 100
            : (b.bet_size ?? 0) * (b.side === 'YES' ? (b.fill_price ?? 50) / 100 : (100 - (b.fill_price ?? 50)) / 100)
          total -= cost
        }
      } else {
        total += winProfit
      }
    }
  }
  return total
}

// ── Today view ──────────────────────────────────────────────────────────

export async function refreshTodayView() {
  await refreshDates()
}

async function refreshDates() {
  const uidParam = state.liveBettorId ? `?user_id=${state.liveBettorId}` : ''
  const datesWithBets = await fetchJson(`/api/ks/dates${uidParam}`).catch(() => [])
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const dates = datesWithBets.includes(today) ? datesWithBets : [today, ...datesWithBets]
  if (!state.selectedDate || !dates.includes(state.selectedDate)) {
    state.selectedDate = datesWithBets[0] || today
  }

  const container = document.getElementById('date-pills')
  container.innerHTML = ''
  for (const d of dates.slice(0, 14)) {
    const pill = document.createElement('button')
    pill.className = 'date-pill' + (d === state.selectedDate ? ' active' : '')
    pill.textContent = fmtDatePill(d)
    pill.addEventListener('click', () => {
      state.selectedDate = d
      refreshDates()
      loadDay(d)
    })
    container.appendChild(pill)
  }
  await loadDay(state.selectedDate)
}

export async function loadDay(date) {
  stopLivePolling()
  const uidParam = state.liveBettorId ? `&user_id=${state.liveBettorId}` : ''
  const [data, schedData] = await Promise.all([
    fetchJson(`/api/ks/daily?date=${date}${uidParam}`).catch(err => { console.error('[loadDay] fetch failed:', err); return null }),
    fetchJson(`/api/ks/schedule?date=${date}`).catch(() => null),
  ])
  if (schedData?.schedule) shared.betSchedule = schedData.schedule

  const list  = document.getElementById('pitcher-list')
  const empty = document.getElementById('empty-today')
  const hdr   = document.getElementById('day-header')
  const liveBanner = document.getElementById('live-banner')

  list.querySelectorAll('.pitcher-card').forEach(el => el.remove())
  if (liveBanner) liveBanner.hidden = true

  if (!data || !data.pitchers?.length) {
    hdr.hidden = true
    empty.hidden = false
    const betList = document.getElementById('sc-bet-list')
    if (betList) betList.innerHTML = '<div class="sc-empty">No bets placed for this date yet.</div><div class="sc-empty-sub">Picks are placed automatically at 9:00 AM Eastern Time.</div>'
    const scSummary = document.getElementById('sc-summary')
    if (scSummary) scSummary.hidden = true
    renderTicker()
    return
  }
  empty.hidden = true

  shared.dailyPitchers = data.pitchers || []
  shared.dayPnl = data.day_pnl ?? 0
  shared.liveOverlay = {}
  renderTicker()

  hdr.hidden = false
  const pnlCls = data.day_pnl >= 0 ? 'good' : 'bad'
  const maxT = computeMaxTheoretical(data.pitchers)
  hdr.innerHTML = `
    <div>
      <div class="day-date">${fmtDateFull(date)}</div>
      <div class="day-meta">${data.pitchers.length} pitcher${data.pitchers.length !== 1 ? 's' : ''} · ${data.day_bets} bets</div>
    </div>
    <div>
      <span id="day-wl" class="day-meta">${data.day_wins}W · ${data.day_losses}L${data.day_pending > 0 ? ` · ${data.day_pending} pending` : ''}</span>
    </div>
    <div id="day-pnl-val" class="day-pnl ${pnlCls}">${data.day_pnl >= 0 ? '+' : ''}${fmt$(data.day_pnl)}</div>
    <div class="day-max-wrap">
      <span class="day-max-label">best case</span>
      <span class="day-max-val" id="day-max-val">${maxT >= 0 ? '+' : ''}${fmt$(maxT)}</span>
    </div>`

  const sorted = [...data.pitchers].sort((a, b) => {
    if (a.game_time && b.game_time) return a.game_time.localeCompare(b.game_time)
    if (a.game_time) return -1
    if (b.game_time) return 1
    return 0
  })

  for (const p of sorted) {
    try {
      list.appendChild(buildPitcherCard(p))
    } catch (err) {
      console.error('[buildPitcherCard] failed for', p.pitcher_name, err)
    }
  }

  try {
    const lbUid = state.liveBettorId ? `&user_id=${state.liveBettorId}` : ''
    const liveBetsData = await fetchJson(`/api/ks/live-bets?date=${date}${lbUid}`).catch(() => null)
    shared.liveBetsPitchers = liveBetsData?.pitchers || []
    renderGameCards(sorted, shared.liveBetsPitchers)
    const heroMax = computeMaxTheoretical(sorted)
    updateBestCaseCard(heroMax, 1, 0)
  } catch (err) { console.error('[renderGameCards]', err) }

  try { await renderDaySummary(date, data) } catch (err) { console.error('[renderDaySummary]', err) }

  startCountdowns()

  if (data.day_pending > 0) startLivePolling(date)
}

export async function renderDaySummary(date, data) {
  const verdictEl = document.getElementById('sh-verdict')
  const recordEl  = document.getElementById('sh-record')

  if (!data || !data.pitchers?.length) {
    if (verdictEl) verdictEl.textContent = 'No bets for this day.'
    if (recordEl)  recordEl.textContent = ''
  } else {
    if (verdictEl) {
      const pnl = state.liveBettorTodayPnl ?? data.day_pnl
      if (pnl === 0 && data.day_wins === 0 && data.day_losses === 0) {
        verdictEl.textContent = `No settled bets yet today.`
      } else {
        const direction = pnl > 0 ? 'UP' : pnl < 0 ? 'DOWN' : 'EVEN'
        const cls       = pnl > 0 ? 'good' : pnl < 0 ? 'bad' : ''
        const amount    = Math.abs(pnl) > 0.005 ? ` <span class="${cls}">${direction} ${fmt$(Math.abs(pnl))}</span>` : ` <span>EVEN</span>`
        verdictEl.innerHTML = `Today you are${amount}`
      }
    }

    if (recordEl) {
      const parts = []
      if (data.day_wins > 0)    parts.push(`${data.day_wins} bet${data.day_wins !== 1 ? 's' : ''} won`)
      if (data.day_losses > 0)  parts.push(`${data.day_losses} lost`)
      if (data.day_pending > 0) parts.push(`${data.day_pending} still settling`)
      if (parts.length === 0 && (data.day_wins + data.day_losses + data.day_pending) === 0)
        parts.push('No activity yet')
      recordEl.textContent = parts.join(' · ')
    }
  }

  const el = document.getElementById('day-summary')
  if (el) el.hidden = true

  const scSummary = document.getElementById('sc-summary')
  const scDate    = document.getElementById('sc-summary-date')
  const scWon     = document.getElementById('sc-won-count')
  const scLost    = document.getElementById('sc-lost-count')
  const scWait    = document.getElementById('sc-wait-count')
  const scTotal   = document.getElementById('sc-day-total')

  if (scSummary) {
    if (!data || !data.pitchers?.length) {
      scSummary.hidden = true
    } else {
      scSummary.hidden = false
      if (scDate) scDate.textContent = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      if (scWon)  scWon.textContent  = data.day_wins    || 0
      if (scLost) scLost.textContent = data.day_losses   || 0
      if (scWait) scWait.textContent = data.day_pending  || 0
      if (scTotal) {
        const pnl = data.day_pnl || 0
        const sign = pnl > 0 ? '+' : ''
        scTotal.textContent = pnl === 0 && data.day_wins === 0 && data.day_losses === 0
          ? 'No settled bets yet'
          : `${pnl > 0 ? 'UP' : pnl < 0 ? 'DOWN' : 'EVEN'} ${sign}${fmt$(Math.abs(pnl))} today`
        scTotal.className = `sc-day-total ${pnl > 0 ? 'sc-up' : pnl < 0 ? 'sc-down' : 'sc-even'}`
      }
    }
  }
}

export async function loadLiveBets(date) {
  const uid = state.liveBettorId ? `&user_id=${state.liveBettorId}` : ''
  const data = await fetchJson(`/api/ks/live-bets?date=${date}${uid}`).catch(() => null)
  const section = document.getElementById('live-bets-section')
  const list    = document.getElementById('live-bets-list')
  const meta    = document.getElementById('lbs-meta')
  if (!section || !list) return

  if (!data || !data.pitchers?.length) {
    section.hidden = true
    return
  }

  const t = data.totals
  const pnlSign = t.pnl >= 0 ? '+' : ''
  const pnlCls  = t.pnl >= 0 ? 'good' : 'bad'
  meta.innerHTML = `${t.bets} bet${t.bets !== 1 ? 's' : ''} · ${t.wins}W ${t.losses}L${t.pending > 0 ? ` · ${t.pending} pending` : ''} · <span class="${pnlCls}">${pnlSign}${fmt$(t.pnl)}</span>`

  list.innerHTML = data.pitchers.map(p => {
    const pnlSign2 = p.pnl >= 0 ? '+' : ''
    const pnlCls2  = p.pnl >= 0 ? 'good' : 'bad'
    const rows = p.bets.map(bet => {
      const label  = bet.side === 'YES' ? `YES ${bet.strike}+` : `NO ${bet.strike}+`
      const ctx    = bet.live_inning ? `${bet.live_inning} · ${bet.live_ks_at_bet ?? '?'}Ks` : ''
      const stCls  = bet.result === 'win' ? 'good' : bet.result === 'loss' ? 'bad' : 'muted'
      const stText = bet.result === 'win' ? 'WIN' : bet.result === 'loss' ? 'LOSS' : 'pending'
      const pnlT   = bet.pnl != null ? `${bet.pnl >= 0 ? '+' : ''}${fmt$(bet.pnl)}` : '—'
      const pnlC   = bet.pnl != null ? (bet.pnl >= 0 ? 'good' : 'bad') : 'muted'
      return `<div class="lbs-row">
        <span class="lbs-bet">${label}</span>
        <span class="lbs-ctx muted">${ctx}</span>
        <span class="lbs-size muted">${fmt$(bet.bet_size)}</span>
        <span class="lbs-status ${stCls}">${stText}</span>
        <span class="lbs-pnl ${pnlC}">${pnlT}</span>
      </div>`
    }).join('')

    return `<div class="lbs-pitcher">
      <div class="lbs-pitcher-name">${p.pitcher_name} <span class="muted">${p.wins}W ${p.losses}L${p.pending > 0 ? ` ${p.pending}⏳` : ''}</span> <span class="${pnlCls2}">${pnlSign2}${fmt$(p.pnl)}</span></div>
      ${rows}
    </div>`
  }).join('')

  section.hidden = false
}

export function updateBestCaseCard(bestCase, atRisk, dayPnl) {
  const bestcaseCard = document.getElementById('sh-bestcase-card')
  const bestcaseEl   = document.getElementById('sh-bestcase')
  if (!bestcaseCard || !bestcaseEl) return
  if (atRisk > 0 || bestCase > 0) {
    const projected = (dayPnl ?? 0) + bestCase
    bestcaseCard.style.display = 'flex'
    const sign = projected >= 0 ? '+' : ''
    bestcaseEl.textContent = sign + fmt$(projected)
    bestcaseEl.className = `sh-stat-value ${projected >= 0 ? 'good' : 'bad'}`
  } else {
    bestcaseCard.style.display = 'none'
  }
}

export function renderGameCards(dailyPitchers, liveBetsPitchers) {
  const container = document.getElementById('sc-bet-list')
  const picksHead = document.getElementById('sc-picks-head')
  if (!container) return

  const map = new Map()
  for (const p of (dailyPitchers || [])) {
    if (!p.bets?.length) continue
    map.set(String(p.pitcher_id), { ...p, bets: p.bets.map(b => ({ ...b, bet_type: 'morning' })) })
  }
  for (const p of (liveBetsPitchers || [])) {
    if (!p.bets?.length) continue
    const key = String(p.pitcher_id)
    if (map.has(key)) {
      map.get(key).bets.push(...p.bets.map(b => ({ ...b, bet_type: 'live' })))
    } else {
      map.set(key, { ...p, bets: p.bets.map(b => ({ ...b, bet_type: 'live' })) })
    }
  }

  const pitchers = [...map.values()]
  if (!pitchers.length) {
    if (picksHead) picksHead.hidden = true
    container.innerHTML = '<div class="sc-empty">No bets placed for this date yet.</div><div class="sc-empty-sub">Picks are placed automatically at 9:00 AM Eastern Time.</div>'
    return
  }
  if (picksHead) { picksHead.hidden = false; picksHead.textContent = "TODAY'S GAMES" }

  const cards = pitchers.map(p => {
    const live = shared.liveOverlay[String(p.pitcher_id)] || null
    return { p, sd: calcPitcherStatus(p, live) }
  })

  cards.sort((a, b) => {
    if ( a.sd.isLive && !b.sd.isLive) return -1
    if (!a.sd.isLive &&  b.sd.isLive) return  1
    if ( a.sd.isLive &&  b.sd.isLive) return b.sd.pendingRisk - a.sd.pendingRisk
    if ( a.sd.isWaiting && !b.sd.isWaiting) return -1
    if (!a.sd.isWaiting &&  b.sd.isWaiting) return  1
    return (a.p.game_time || '').localeCompare(b.p.game_time || '')
  })

  const openIds = new Set(
    [...container.querySelectorAll('.game-card.gc-expanded')].map(el => el.id)
  )

  container.innerHTML = cards.map(({ p, sd }) => renderGameCard(p, sd)).join('')

  for (const id of openIds) {
    const card = document.getElementById(id)
    const det  = document.getElementById(`${id}-det`)
    if (card && det) {
      det.hidden = false
      card.classList.add('gc-expanded')
      const arr = card.querySelector('.gc-expand')
      if (arr) arr.textContent = '‹'
    }
  }
}

function renderGameCard(p, sd) {
  const cfg    = GC_STATUS_CFG[sd.status] || GC_STATUS_CFG.waiting
  const cardId = `gc-${p.pitcher_id}`

  const matchupMeta = [p.game, p.game_time ? fmtGameTime(p.game_time) : null].filter(Boolean).join(' · ')

  let progressHtml = ''
  if (sd.progressPct != null && sd.progressDen != null && sd.isLive) {
    const pct = sd.progressPct
    const fc  = pct >= 75 ? 'good' : pct >= 45 ? 'warn' : 'bad'
    const ps  = sd.nextBetProb != null
      ? ` · <span class="${sd.nextBetProb >= 0.6 ? 'good' : sd.nextBetProb >= 0.4 ? 'warn' : 'bad'}">${Math.round(sd.nextBetProb * 100)}% chance</span>`
      : ''
    progressHtml = `<div class="gc-progress-wrap">
      <div class="gc-progress-track"><div class="gc-progress-fill ${fc}" style="width:${pct}%"></div></div>
      <div class="gc-progress-label">${sd.progressNum} / ${sd.progressDen} Ks${ps}</div>
    </div>`
  }

  let moneyHtml
  if (sd.isFinished) {
    const cls = sd.netLocked >= 0.01 ? 'good' : sd.netLocked < -0.01 ? 'bad' : 'muted'
    moneyHtml = `<div class="gc-money-row">
      <div class="gc-money-main">
        <div class="gc-money-label">Final Result</div>
        <div class="gc-money-val ${cls}">${sd.netLocked >= 0 ? '+' : ''}${fmt$(sd.netLocked)}</div>
      </div>
    </div>`
  } else {
    const lCls  = sd.netLocked >= 0.01 ? 'good' : sd.netLocked < -0.01 ? 'bad' : 'muted'
    const bcCls = sd.totalBestCase > 0.01 ? 'good' : sd.totalBestCase < -0.01 ? 'bad' : 'muted'
    moneyHtml = `<div class="gc-money-row">
      <div class="gc-money-main">
        <div class="gc-money-label">Locked In</div>
        <div class="gc-money-val ${lCls}">${sd.netLocked >= 0 ? '+' : ''}${fmt$(sd.netLocked)}</div>
      </div>
      <div class="gc-money-main">
        <div class="gc-money-label">Best Case</div>
        <div class="gc-money-val ${bcCls}">${sd.totalBestCase >= 0 ? '+' : ''}${fmt$(sd.totalBestCase)}</div>
      </div>
      ${sd.pendingRisk > 0.01 ? `<div class="gc-money-risk">${fmt$(sd.pendingRisk)} still at risk</div>` : ''}
    </div>`
  }

  const ICONS = { locked_win:'✅', locked_loss:'❌', strong:'🟢', in_play:'🟡', unlikely:'🔴', waiting:'⏳' }
  const rows = [...sd.enrichedBets]
    .sort((a, b) => a.strike !== b.strike ? a.strike - b.strike : a.bet_type === 'morning' ? -1 : 1)
    .map(b => {
      const tag  = b.bet_type === 'live' ? `<span class="gc-bet-tag">LIVE</span>` : ''
      const prob = !b.result && b.prob != null
        ? `<span class="gc-bet-prob ${b.prob >= 0.6 ? 'good' : b.prob >= 0.4 ? 'warn' : 'bad'}">${Math.round(b.prob * 100)}%</span>` : ''
      const pnl  = b.result
        ? `<span class="${(b.pnl ?? 0) >= 0 ? 'good' : 'bad'}">${(b.pnl ?? 0) >= 0 ? '+' : ''}${fmt$(b.pnl ?? 0)}</span>`
        : `<span class="muted">+${fmt$(b.winProfit)} if hits</span>`
      return `<div class="gc-bet-row">
        <span class="gc-bet-icon">${ICONS[b.thresholdStatus] || '⏳'}</span>
        <span class="gc-bet-label">${b.side} ${b.strike}+${tag}</span>
        ${prob}<span class="gc-bet-pnl">${pnl}</span>
      </div>`
    }).join('')

  return `<div class="game-card ${cfg.cls}" id="${cardId}" data-pitcher-id="${p.pitcher_id}" data-pending-risk="${sd.pendingRisk.toFixed(2)}">
    <div class="gc-status-band ${cfg.cls}">${cfg.label}</div>
    <div class="gc-body">
      <div class="gc-pitcher">${esc(p.pitcher_name)}</div>
      ${matchupMeta ? `<div class="gc-meta">${esc(matchupMeta)}</div>` : ''}
      <div class="gc-story">${sd.storySentence}</div>
      ${sd.situationLine ? `<div class="gc-situation">${esc(sd.situationLine)}</div>` : ''}
      ${sd.whatNeeds && !sd.isFinished ? `<div class="gc-what-needs">${esc(sd.whatNeeds)}</div>` : ''}
      ${sd.projectedRange && sd.isWaiting ? `<div class="gc-projected">Model projects ~${esc(sd.projectedRange)} Ks</div>` : ''}
      ${progressHtml}
    </div>
    ${moneyHtml}
    <button class="gc-expand-toggle" onclick="toggleGcDetails('${cardId}')">
      <span id="${cardId}-tlbl">Show details ›</span>
    </button>
    <div class="gc-details" id="${cardId}-det" hidden>
      <div class="gc-thresholds">${rows}</div>
    </div>
  </div>`
}

function toggleGcDetails(cardId) {
  const det   = document.getElementById(`${cardId}-det`)
  const label = document.getElementById(`${cardId}-tlbl`)
  if (!det) return
  const opening = det.hidden
  det.hidden = !opening
  if (label) label.textContent = opening ? 'Hide details ‹' : 'Show details ›'
}

export function buildPitcherCard(p) {
  const KALSHI_FEE = 0.07
  const card = document.createElement('article')
  let colorCls = 'pending'
  if (p.pending === 0) {
    if (p.losses === 0 && p.wins > 0)      colorCls = 'win'
    else if (p.wins === 0 && p.losses > 0) colorCls = 'loss'
    else if (p.wins > 0 && p.losses > 0)   colorCls = 'mixed'
  }
  card.className = `pitcher-card ${colorCls}${hasFreeMoney ? ' free-money' : ''}`
  if (p.pitcher_id) card.dataset.pitcherId = p.pitcher_id
  if (p.game_time)  card.dataset.gameTime  = p.game_time

  const pnlCls = p.pnl >= 0 ? 'good' : 'bad'
  const pnlStr = p.pnl != null && (p.wins + p.losses) > 0
    ? `<span class="${pnlCls}">${p.pnl >= 0 ? '+' : ''}${fmt$(p.pnl)}</span>`
    : ''

  let statusChips = ''
  if (p.pending > 0 && p.wins === 0 && p.losses === 0) {
    statusChips = `<span class="pc-chip pending">${p.pending} pending</span>`
  } else {
    if (p.wins   > 0) statusChips += `<span class="pc-chip win">${p.wins}W</span>`
    if (p.losses > 0) statusChips += `<span class="pc-chip loss">${p.losses}L</span>`
    if (p.pending > 0) statusChips += `<span class="pc-chip pending">${p.pending} live</span>`
  }

  let totalRisk = 0
  for (const b of p.bets) {
    const mid = b.market_mid != null ? Number(b.market_mid) / 100 : 0.5
    const hs  = (b.spread ?? 4) / 200
    const fill = b.side === 'YES' ? mid + hs : (1 - mid) + hs
    totalRisk += (b.bet_size ?? 0) * fill
  }
  card.dataset.stake = totalRisk

  const totalBets  = p.wins + p.losses + p.pending
  const overallPct = totalBets > 0 ? Math.round(p.wins / totalBets * 100) : 0
  const overallClr = overallPct >= 60 ? 'good' : overallPct >= 30 ? '' : (p.losses > 0 ? 'bad' : '')

  const pendingBets  = p.bets.filter(b => !b.result)
  const hasFreeMoney = pendingBets.some(b => b.bet_mode === 'pulled' || (b.model_prob != null && b.model_prob <= 0.03 && b.side === 'NO'))
  const coverProb    = b => b.side === 'NO' ? 1 - (b.model_prob ?? 0.5) : (b.model_prob ?? 0.5)
  const avgCoverage  = pendingBets.length > 0
    ? pendingBets.reduce((s, b) => s + coverProb(b), 0) / pendingBets.length
    : p.bets.length > 0 ? p.bets.reduce((s, b) => s + coverProb(b), 0) / p.bets.length : null
  const coverPct = avgCoverage != null ? Math.round(avgCoverage * 100) : null
  const coverCls = coverPct >= 60 ? 'good' : coverPct >= 40 ? 'warn' : 'bad'
  card.dataset.coverage = coverPct ?? 0

  const s = p.bets[0] || {}
  const firstName = p.pitcher_name.split(' ').pop()

  const lambdaStr   = s.lambda       != null ? s.lambda.toFixed(1) : null
  const parkStr     = s.park_factor  != null && Math.abs(s.park_factor - 1) > 0.01
                        ? `×${s.park_factor.toFixed(2)}` : 'neutral'
  const umpStr      = s.ump_name     != null ? `${s.ump_name}${s.ump_factor != null && Math.abs(s.ump_factor - 1) > 0.01 ? ` (×${s.ump_factor.toFixed(2)})` : ''}` : '—'
  const wxStr       = s.weather_mult != null && Math.abs(s.weather_mult - 1) > 0.01
                        ? `×${s.weather_mult.toFixed(2)}` : 'neutral'
  const veloStr     = s.velo_trend_mph != null ? `${s.velo_trend_mph >= 0 ? '+' : ''}${s.velo_trend_mph.toFixed(1)} mph` : null
  const k9Str       = s.k9_season    != null ? s.k9_season.toFixed(1) : null
  const whiffStr    = s.savant_whiff != null ? `${(s.savant_whiff * 100).toFixed(1)}%` : null
  const avgEdgeCents = p.bets.reduce((sum, b) => sum + (b.edge != null ? Number(b.edge) * 100 : 0), 0) / p.bets.length

  const signalItems = [
    lambdaStr  ? `<div class="pc-sig"><span>Expected Ks</span><b>${lambdaStr}</b></div>` : '',
    k9Str      ? `<div class="pc-sig"><span>Ks per 9 inn.</span><b>${k9Str}</b></div>` : '',
    whiffStr   ? `<div class="pc-sig"><span>Swing &amp; Miss</span><b>${whiffStr}</b></div>` : '',
    `<div class="pc-sig"><span>Our Edge</span><b class="good">+${avgEdgeCents.toFixed(1)}¢</b></div>`,
    `<div class="pc-sig"><span>Ballpark</span><b>${parkStr}</b></div>`,
    `<div class="pc-sig"><span>Home Plate Ump</span><b>${umpStr}</b></div>`,
    veloStr    ? `<div class="pc-sig"><span>Fastball Trend</span><b>${veloStr}</b></div>` : '',
    `<div class="pc-sig"><span>Weather</span><b>${wxStr}</b></div>`,
  ].filter(Boolean).join('')

  const whyParts = []
  if (lambdaStr) whyParts.push(`Model expects ${firstName} to average ~${lambdaStr} Ks today.`)
  if (avgEdgeCents >= 5) whyParts.push(`Market is consistently underpricing him — avg ${avgEdgeCents.toFixed(1)}¢ edge across all thresholds.`)
  if (s.park_factor != null && s.park_factor < 0.97) whyParts.push(`Pitcher-friendly ballpark helps.`)
  if (s.park_factor != null && s.park_factor > 1.03) whyParts.push(`Hitter-friendly park — factor into expectations.`)
  if (s.ump_factor  != null && s.ump_factor  > 1.03) whyParts.push(`Umpire ${s.ump_name} calls a big strike zone.`)
  if (s.ump_factor  != null && s.ump_factor  < 0.97) whyParts.push(`Umpire ${s.ump_name} has a tight zone — could suppress Ks.`)
  if (s.velo_trend_mph != null && s.velo_trend_mph >= 0.5)  whyParts.push(`Velocity trending up +${s.velo_trend_mph.toFixed(1)} mph.`)
  if (s.velo_trend_mph != null && s.velo_trend_mph <= -0.5) whyParts.push(`Velocity trending down ${s.velo_trend_mph.toFixed(1)} mph — watch closely.`)
  const whyText = whyParts.join(' ') || 'Picked based on model edge vs. market price.'

  const heatMap = (() => {
    if (!p.recent_ks?.length) return ''
    const thresholds = [...new Set(p.bets.map(b => b.strike))].sort((a,b) => a - b)
    if (!thresholds.length) return ''
    const cols = p.recent_ks.map((ks, i) => {
      const cells = thresholds.map(t =>
        `<div class="hm-cell ${ks >= t ? 'hm-hit' : 'hm-miss'}" title="${ks} Ks vs ${t}+">${ks}</div>`
      )
      return `<div class="hm-col"><div class="hm-start-label">S-${p.recent_ks.length - i}</div>${cells.join('')}</div>`
    })
    const rowLabels = thresholds.map(t => `<div class="hm-row-label">${t}+</div>`).join('')
    return `<div class="pc-heatmap">
      <div class="hm-header">Last ${p.recent_ks.length} starts</div>
      <div class="hm-body">
        <div class="hm-labels"><div class="hm-corner"></div>${rowLabels}</div>
        <div class="hm-cols">${cols.join('')}</div>
      </div>
    </div>`
  })()

  const betRows = p.bets.map(b => {
    const mid        = b.market_mid != null ? Number(b.market_mid) : null
    const face       = b.bet_size   != null ? Number(b.bet_size)   : null
    const halfSpread = (b.spread ?? 4) / 2
    const fillCents  = mid != null ? (b.side === 'YES' ? mid + halfSpread : (100 - mid) + halfSpread) : null
    const winCents   = mid != null ? (b.side === 'YES' ? (100 - mid) - halfSpread : mid - halfSpread) : null
    const wager  = fillCents != null && face != null ? fmt$(face * fillCents / 100) : '—'
    const potWin = winCents  != null && face != null && fillCents != null ? fmt$(face * winCents / 100 * (1 - KALSHI_FEE * fillCents / 100)) : '—'
    const edgeStr = b.edge != null ? `Edge: +${(b.edge * 100).toFixed(1)}¢` : ''
    const midStr  = b.market_mid != null ? `Market: ${b.market_mid}¢` : ''

    const direction = b.side === 'YES'
      ? `<strong>${b.strike}+</strong> Ks YES`
      : `Under <strong>${b.strike}</strong> Ks NO`

    let badge, moneyStr
    if (b.result === 'win') {
      badge    = `<span class="pc-badge pc-badge--win">✓ WIN</span>`
      moneyStr = `<span class="pc-money-win">+${fmt$(b.pnl)}</span>`
    } else if (b.result === 'loss') {
      badge    = `<span class="pc-badge pc-badge--loss">✗ LOSS</span>`
      moneyStr = `<span class="pc-money-loss">${fmt$(b.pnl)}</span>`
    } else {
      badge    = `<span class="pc-badge pc-badge--pending">Pending</span>`
      moneyStr = `<span class="pc-money-potential">→ ${potWin}</span>`
    }

    const kalshiBtn = b.ticker
      ? `<a class="pc-kalshi-btn" href="https://kalshi.com/markets/kxmlbks/${b.ticker}" target="_blank" rel="noopener">Kalshi →</a>`
      : ''

    let orderConfirm = ''
    if (b.order_id) {
      const contracts = b.filled_contracts ?? b.bet_size
      const price = b.fill_price != null ? Math.round(b.fill_price) : b.market_mid != null ? Math.round(b.market_mid) : null
      const cost = contracts != null && price != null ? fmt$(contracts * price / 100) : null
      const timeDisp = b.filled_at ? fmtTs(b.filled_at) : ''
      const statusCls  = b.order_status === 'filled'    ? 'good'
                       : b.order_status === 'cancelled'  ? 'bad'
                       : b.order_status === 'partial'    ? 'warn' : ''
      const statusLabel = b.order_status === 'filled'    ? '✓ Filled'
                        : b.order_status === 'cancelled'  ? '✗ Cancelled'
                        : b.order_status === 'partial'    ? '⏳ Partially Filled'
                        : '⏳ Maker Order Resting'
      const detail = [
        contracts != null ? `${contracts} contracts` : null,
        price != null ? `@ ${price}¢ each` : null,
        cost ? `= ${cost}` : null,
      ].filter(Boolean).join(' ')
      orderConfirm = `<div class="pc-order-confirm">
        <span class="pc-order-chip ${statusCls}">${statusLabel}</span>
        <span class="pc-order-detail">${detail}</span>
        ${timeDisp ? `<span class="pc-order-time">${timeDisp}</span>` : ''}
      </div>`
    } else if (b.paper === 0) {
      orderConfirm = `<div class="pc-order-confirm"><span class="pc-order-chip">Real Bet Placed</span></div>`
    }

    let liveBadge = ''
    if (b.live) {
      const lv = b.live
      const contracts = lv.filled_contracts ?? lv.bet_size ?? '?'
      const price = lv.fill_price != null ? `${Math.round(lv.fill_price)}¢` : ''
      const spent = lv.fill_price != null && lv.filled_contracts != null
        ? fmt$(lv.filled_contracts * lv.fill_price / 100) : ''
      let livePnlHtml = ''
      if (lv.result === 'win') {
        livePnlHtml = `<span class="pc-live-pnl win">+${fmt$(lv.pnl)}</span>`
      } else if (lv.result === 'loss') {
        livePnlHtml = `<span class="pc-live-pnl loss">${fmt$(lv.pnl)}</span>`
      }
      const liveDetail = [
        contracts != null ? `${contracts} contracts` : null,
        price ? `@ ${price} each` : null,
        spent ? `= ${spent}` : null,
      ].filter(Boolean).join(' ')
      liveBadge = `<div class="pc-live-badge">
        <span class="pc-live-chip">💵 Real Money</span>
        <span class="pc-live-detail">${liveDetail}</span>
        ${livePnlHtml}
      </div>`
    }

    const rowCls = b.result === 'win' ? 'pc-bet-row--win' : b.result === 'loss' ? 'pc-bet-row--loss' : ''
    const tooltipText = b.side === 'YES'
      ? `${firstName} needs at least ${b.strike} strikeout${b.strike !== 1 ? 's' : ''} for this bet to win`
      : `${firstName} must stay under ${b.strike} strikeout${b.strike !== 1 ? 's' : ''} for this NO bet to win`

    const betCoverPct = b.model_prob != null ? Math.round((b.side === 'NO' ? 1 - b.model_prob : b.model_prob) * 100) : null
    const betCoverCls = betCoverPct >= 60 ? 'good' : betCoverPct >= 40 ? 'warn' : 'bad'
    const betCoverTag = betCoverPct != null ? `<span class="pc-bet-cover ${betCoverCls}">${betCoverPct}%</span>` : ''

    let progressBar
    if (b.result === 'win') {
      progressBar = `<div class="pc-ks-progress">
        <div class="pc-ks-bar"><div class="pc-ks-fill hit" style="width:100%"></div></div>
        <span class="pc-ks-label">✓ ${b.actual_ks ?? b.strike}+ Ks hit</span>
        ${betCoverTag}
      </div>`
    } else if (b.result === 'loss') {
      progressBar = `<div class="pc-ks-progress">
        <div class="pc-ks-bar"><div class="pc-ks-fill miss" style="width:100%"></div></div>
        <span class="pc-ks-label">✗ ${b.actual_ks ?? '?'} Ks</span>
        ${betCoverTag}
      </div>`
    } else {
      const lbl = b.side === 'YES' ? `0 / ${b.strike} Ks` : `0 Ks (need < ${b.strike})`
      progressBar = `<div class="pc-ks-progress">
        <div class="pc-ks-bar"><div class="pc-ks-fill" style="width:0%"></div></div>
        <span class="pc-ks-label">${lbl}</span>
        ${betCoverTag}
      </div>`
    }

    const isNew = b.logged_at && (Date.now() - new Date(b.logged_at).getTime()) < 45 * 60 * 1000
    const newPill = isNew ? `<span class="pc-new-pill">NEW</span>` : ''
    const isFreeMoney = (b.bet_mode === 'pulled' || (b.model_prob != null && b.model_prob <= 0.03 && b.side === 'NO'))
    const freeMoneyPill = isFreeMoney ? `<span class="pc-free-money-pill">💰 FREE MONEY</span>` : ''

    return `<div class="pc-bet-row ${rowCls}${isFreeMoney ? ' pc-bet-row--free-money' : ''}" data-bet-id="${b.id}" data-strike="${b.strike}" data-side="${b.side}" title="${esc(tooltipText)}">
      <div class="pc-bet-row-main">
        <div class="pc-bet-row-left">
          <span class="pc-bet-row-desc">${direction}${newPill}${freeMoneyPill}</span>
          <span class="pc-bet-row-meta">${[edgeStr, midStr].filter(Boolean).join(' · ')}</span>
        </div>
        <div class="pc-bet-row-right">
          <span class="pc-bet-wager">${wager}</span>
          ${moneyStr}
          ${badge}
          ${kalshiBtn}
        </div>
      </div>
      ${progressBar}
      ${orderConfirm}
      ${liveBadge}
    </div>`
  }).join('')

  card.innerHTML = `
    ${hasFreeMoney ? `<div class="pc-free-money-banner">💰 FREE MONEY — Pitcher pulled, market hasn't repriced</div>` : ''}
    <div class="pc-header">
      <div class="pc-header-left">
        <div class="pc-pitcher">${esc(p.pitcher_name)}</div>
        <div class="pc-meta">${esc(p.game || p.team || '—')}${p.game_time ? ` · <span class="pc-gametime">${fmtGameTime(p.game_time)}</span><span class="pc-countdown" data-game-time="${esc(p.game_time)}"></span>` : ''}</div>
      </div>
      <div class="pc-header-right">
        <div class="pc-actual-ks">${p.actual_ks != null ? `<strong>${p.actual_ks}</strong> Ks` : ''}</div>
        ${coverPct != null ? `<div class="pc-coverage ${coverCls}">${coverPct}% cover</div>` : ''}
        <div class="pc-header-chips">${statusChips}</div>
        <div class="pc-header-risk">${fmt$(totalRisk)} at risk</div>
        ${pnlStr ? `<div class="pc-header-pnl">${pnlStr}</div>` : ''}
        <div class="pc-expand-arrow">›</div>
      </div>
    </div>
    <div class="pc-overall-bar"><div class="pc-overall-fill ${overallClr}" style="width:${overallPct}%"></div></div>
    <div class="pc-body" hidden>
      <div class="pc-signals-section">
        <div class="pc-signals">${signalItems}</div>
        <p class="pc-why-text">${whyText}</p>
      </div>
      ${heatMap}
      <div class="pc-bet-rows">${betRows}</div>
    </div>`

  return card
}

function toggleScDetails(cardId) {
  const card = document.getElementById(cardId)
  if (!card) return
  card.classList.toggle('sc-details-open')
  if (card.classList.contains('sc-details-open')) {
    card.querySelectorAll('.sc-sparkline[data-ticker]:not([data-loaded])').forEach(el => {
      loadSparkline(el)
    })
  }
}

export async function buildBettorDrawer(drawer, b) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const uid = b.id
  const [dailyData, liveBetsData] = await Promise.all([
    fetchJson(`/api/ks/daily?date=${today}&user_id=${uid}`).catch(() => ({ pitchers: [] })),
    fetchJson(`/api/ks/live-bets?date=${today}&user_id=${uid}`).catch(() => ({ pitchers: [], totals: { bets: 0 } })),
  ])

  const KALSHI_FEE = 0.07
  const allBets = (dailyData.pitchers || []).flatMap(p => p.bets.map(bet => ({ ...bet, pitcher_name: p.pitcher_name })))
  const wins    = allBets.filter(x => x.result === 'win').length
  const losses  = allBets.filter(x => x.result === 'loss').length
  const pending = allBets.filter(x => !x.result).length
  const settled = allBets.filter(x => x.result)
  const settledPnl = settled.reduce((s, x) => s + (x.pnl || 0), 0)

  let atRisk = 0, bestCase = 0
  for (const bet of allBets.filter(x => !x.result)) {
    const mid  = Number(bet.market_mid ?? 50)
    const face = Number(bet.bet_size   ?? 0)
    const hs   = (bet.spread ?? 4) / 2
    const fill = bet.side === 'YES' ? mid + hs : (100 - mid) + hs
    const win  = bet.side === 'YES' ? (100 - mid) - hs : mid - hs
    atRisk   += face * fill / 100
    bestCase += face * win / 100 * (1 - KALSHI_FEE * fill / 100)
  }

  const pnlCls  = settledPnl >= 0 ? 'good' : 'bad'
  const pnlSign = settledPnl >= 0 ? '+' : ''

  const sorted = [...allBets].sort((a, x) => {
    if (a.result && !x.result) return -1
    if (!a.result && x.result) return 1
    if (a.result === 'win' && x.result === 'loss') return -1
    if (a.result === 'loss' && x.result === 'win') return 1
    return (a.pitcher_name || '').localeCompare(x.pitcher_name || '')
  })

  const pregameRows = sorted.map(bet => {
    const label   = bet.side === 'YES' ? `YES ${bet.strike}+` : `NO ${bet.strike}+`
    const stCls   = bet.result === 'win' ? 'good' : bet.result === 'loss' ? 'bad' : 'muted'
    const stText  = bet.result === 'win' ? 'WIN' : bet.result === 'loss' ? 'LOSS' : '⏳'
    const pnlText = bet.pnl != null ? `${bet.pnl >= 0 ? '+' : ''}${fmt$(bet.pnl)}` : '—'
    const pnlC    = bet.pnl != null ? (bet.pnl >= 0 ? 'good' : 'bad') : 'muted'
    return `<div class="dr-row">
      <span class="dr-pitcher">${bet.pitcher_name.split(' ').pop()}</span>
      <span class="dr-label">${label}</span>
      <span class="dr-size muted">${fmt$(bet.bet_size)}</span>
      <span class="dr-status ${stCls}">${stText}</span>
      <span class="dr-pnl ${pnlC}">${pnlText}</span>
    </div>`
  }).join('')

  const balance = b.kalshi_balance != null ? fmt$(b.kalshi_balance) : 'Paper'
  const modeCls = b.paper ? 'muted' : 'good'

  drawer.innerHTML = `
    <div class="dr-inner">
      <div class="dr-summary">
        <div class="dr-sum-cell">
          <div class="dr-sum-label">SETTLED P&L</div>
          <div class="dr-sum-val ${pnlCls}">${pnlSign}${fmt$(settledPnl)}</div>
          <div class="dr-sum-sub">${wins}W · ${losses}L · ${wins + losses} done</div>
        </div>
        <div class="dr-sum-cell">
          <div class="dr-sum-label">PENDING</div>
          <div class="dr-sum-val">${pending}</div>
          <div class="dr-sum-sub">${fmt$(atRisk)} at risk</div>
        </div>
        <div class="dr-sum-cell">
          <div class="dr-sum-label">BEST CASE</div>
          <div class="dr-sum-val good">+${fmt$(bestCase)}</div>
          <div class="dr-sum-sub">if all pending win</div>
        </div>
      </div>

      <div class="dr-section">
        <div class="dr-section-head">PRE-GAME BETS <span class="muted">${allBets.length} total</span></div>
        <div class="dr-col-head"><span>Pitcher</span><span>Bet</span><span>Size</span><span>Status</span><span>P&L</span></div>
        ${pregameRows || '<div class="dr-empty">No bets logged for this date.</div>'}
      </div>

      <div class="dr-section dr-section-account">
        <div class="dr-sum-cell">
          <div class="dr-sum-label">ACCOUNT</div>
          <div class="dr-sum-val">${balance}</div>
          <div class="dr-sum-sub"><span class="${modeCls}">${b.paper ? '💧 Dry Mode' : '⚡ Live'}</span></div>
        </div>
        <div class="dr-sum-cell">
          <div class="dr-sum-label">DAILY BUDGET</div>
          <div class="dr-sum-val">${fmt$(b.bankroll * b.daily_risk_pct)}</div>
          <div class="dr-sum-sub">${(b.daily_risk_pct * 100).toFixed(0)}% of bankroll</div>
        </div>
      </div>
    </div>`
}

export async function loadSparkline(el) {
  el.dataset.loaded = '1'
  const ticker = el.dataset.ticker
  if (!ticker) return
  try {
    const data = await fetchJson(`/api/ks/candles?ticker=${encodeURIComponent(ticker)}&period=60`)
    if (data?.candles?.length >= 2) {
      renderSparkline(el, data.candles, {
        fillPrice: el.dataset.fill ? Number(el.dataset.fill) : null,
        result:    el.dataset.result || null,
        side:      el.dataset.side  || 'YES',
      })
    } else {
      el.innerHTML = '<span class="sc-spark-empty">No price history</span>'
    }
  } catch {
    el.innerHTML = ''
  }
}
