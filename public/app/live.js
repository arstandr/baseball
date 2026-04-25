import { state, shared } from './state.js'
import { fmt$, esc, fmtGameTime, remainingLambda, poissonCDF, probAtLeast } from './utils.js'
import { fetchJson } from './api.js'
import { renderTicker } from './ticker.js'
import {
  renderDaySummary, renderGameCards, loadDay, loadLiveBets,
  updateBestCaseCard, stopLivePolling,
} from './views/today.js'

// ── Live state tracker (for transition notifications) ───────────────────────

const _prevLiveState = {}

function _checkTransitions(pitchers) {
  for (const p of pitchers) {
    const pid  = String(p.pitcher_id)
    const prev = _prevLiveState[pid]

    if (prev) {
      if (!prev.is_postponed && p.is_postponed) {
        showToast(`🌧 ${p.pitcher_name}'s game has been postponed`, 'warn')
      } else if (prev.ip === 0 && p.ip > 0 && !p.is_final) {
        showToast(`🏟 ${p.pitcher_name}'s game is now live`, 'info')
      } else if (!prev.is_pitching && p.is_pitching) {
        showToast(`⚡ ${p.pitcher_name} is now on the mound`, 'info')
      } else if (prev.still_in && !p.still_in && !p.is_final) {
        showToast(`⚠️ ${p.pitcher_name} pulled after ${p.ks}K`, 'warn')
      } else if (!prev.is_final && p.is_final) {
        showToast(`🏁 ${p.pitcher_name} finished with ${p.ks}K`, 'info')
      }
    }

    _prevLiveState[pid] = {
      ip: p.ip, is_pitching: p.is_pitching, still_in: p.still_in,
      is_final: p.is_final, is_postponed: !!p.is_postponed,
    }
  }
}

// ── SSE connection ──────────────────────────────────────────────────────────

export function connectSSE() {
  const es = new EventSource('/api/events')
  es.onmessage = e => {
    try {
      const ev = JSON.parse(e.data)
      const date = state.selectedDate || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      if (ev.lastDataUpdate) _updateLastUpdated(ev.lastDataUpdate)
      if (ev.type === 'settled') {
        renderTicker()
        const prevResults = {}
        for (const p of shared.dailyPitchers) {
          for (const b of p.bets) {
            prevResults[b.id] = { result: b.result, pitcher_name: p.pitcher_name, pitcher_id: p.pitcher_id }
          }
        }
        if (state.view === 'today') {
          loadDay(date).then(() => {
            const newlyCovered = new Set()
            for (const p of shared.dailyPitchers) {
              for (const b of p.bets) {
                const prev = prevResults[b.id]
                if (!prev || prev.result) continue
                if (b.result === 'win') {
                  if (!newlyCovered.has(String(p.pitcher_id))) {
                    newlyCovered.add(String(p.pitcher_id))
                    flashPitcherCard(p.pitcher_id, 'win', p.pitcher_name)
                  }
                } else if (b.result === 'loss') {
                  if (!newlyCovered.has(String(p.pitcher_id))) {
                    newlyCovered.add(String(p.pitcher_id))
                    flashPitcherCard(p.pitcher_id, 'loss', p.pitcher_name)
                  }
                }
              }
            }
          })
        }
        document.dispatchEvent(new CustomEvent('ks:refresh-bettors'))
      }
      if (ev.type === 'live_bet') {
        if (state.view === 'today') loadLiveBets(date)
        document.dispatchEvent(new CustomEvent('ks:refresh-bettors'))
      }
      if (ev.type === 'morning_bet') {
        if (state.view === 'today') loadDay(date)
        document.dispatchEvent(new CustomEvent('ks:refresh-bettors'))
      }
      if (ev.type === 'fill_update') {
        if (state.view === 'today') loadDay(date)
        document.dispatchEvent(new CustomEvent('ks:refresh-bettors'))
        renderTicker()
      }
      if (ev.type === 'balance_update' || ev.type === 'pnl_update') {
        document.dispatchEvent(new CustomEvent('ks:refresh-bettors'))
      }
      if (ev.type === 'live_update' && ev.pitchers?.length) {
        _checkTransitions(ev.pitchers)
        if (state.view === 'today') {
          // Update overlay before re-render so renderGameCards picks up fresh live data
          for (const p of ev.pitchers) {
            shared.liveOverlay[String(p.pitcher_id)] = {
              ks: p.ks, still_in: p.still_in, is_final: p.is_final,
              ip: p.ip, pitches: p.pitches, inning: p.inning,
              home_score: p.home_score, away_score: p.away_score,
              inning_state: p.inning_state, is_pitching: p.is_pitching,
              balls: p.balls ?? null, strikes: p.strikes ?? null, outs: p.outs ?? null,
            }
          }
          renderGameCards(shared.dailyPitchers, shared.liveBetsPitchers)
          renderLiveBanner({ pitchers: ev.pitchers })
          updateBannerChipColors(ev.pitchers)
        }
        document.dispatchEvent(new CustomEvent('ks:refresh-bettors'))
      }
    } catch {}
  }
  es.onerror = () => { es.close(); setTimeout(connectSSE, 5000) }
}

// ── Last-updated helpers ────────────────────────────────────────────────────

function _fmtAgo(ts) {
  if (!ts) return null
  const d = new Date(ts)
  const now = new Date()
  const diffMin = Math.round((now - d) / 60000)
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const ago = diffMin < 2 ? 'just now'
    : diffMin < 60   ? `${diffMin}m ago`
    : diffMin < 1440 ? `${Math.round(diffMin / 60)}h ago`
    : `${Math.round(diffMin / 1440)}d ago`
  return { timeStr, ago }
}

export function updateLastUpdated(ts) {
  const el = document.getElementById('last-updated')
  if (!el || !ts) return
  const f = _fmtAgo(ts)
  if (f) el.textContent = `Updated ${f.timeStr} (${f.ago})`
}

function _updateLastUpdated(ts) { updateLastUpdated(ts) }

// ── Live poll (kept for manual/debug use — not called by any interval) ──────

export async function pollLive(date) {
  const uid = state.liveBettorId ? `&user_id=${state.liveBettorId}` : ''
  const data = await fetchJson(`/api/ks/live?date=${date}${uid}`).catch(() => null)
  if (!data) return

  for (const p of data.pitchers) {
    updatePitcherCardLive(p)
  }

  renderLiveBanner(data)
  updateBannerChipColors(data.pitchers)

  for (const p of data.pitchers) {
    shared.liveOverlay[String(p.pitcher_id)] = {
      ks:           p.ks,
      still_in:     p.still_in,
      is_final:     p.is_final,
      ip:           p.ip,
      pitches:      p.pitches,
      inning:       p.inning,
      home_score:   p.home_score,
      away_score:   p.away_score,
      inning_state: p.inning_state,
      is_pitching:  p.is_pitching,
      balls:        p.balls   ?? null,
      strikes:      p.strikes ?? null,
      outs:         p.outs    ?? null,
    }
  }

  const list = document.getElementById('pitcher-list')
  if (list) {
    const cards = [...list.querySelectorAll('.pitcher-card')]
    cards.sort((a, b) => {
      const aLive  = !!a.querySelector('.pc-live-chip.live')
      const bLive  = !!b.querySelector('.pc-live-chip.live')
      const aFinal = !!a.querySelector('.pc-live-chip.final')
      const bFinal = !!b.querySelector('.pc-live-chip.final')
      if (aLive  !== bLive)  return aLive  ? -1 : 1
      if (aFinal !== bFinal) return aFinal ?  1 : -1
      if (aLive  && bLive)   return Number(b.dataset.coverage || 0) - Number(a.dataset.coverage || 0)
      const at = a.dataset.gameTime || '', bt = b.dataset.gameTime || ''
      if (at && bt) return at.localeCompare(bt)
      return at ? -1 : bt ? 1 : 0
    })
    cards.forEach(c => list.appendChild(c))
  }

  try {
    const uidParam = state.liveBettorId ? `&user_id=${state.liveBettorId}` : ''
    const [freshDaily, liveBetsData, schedData] = await Promise.all([
      fetchJson(`/api/ks/daily?date=${date}${uidParam}`).catch(() => null),
      fetchJson(`/api/ks/live-bets?date=${date}${uidParam}`).catch(() => null),
      fetchJson(`/api/ks/schedule?date=${date}`).catch(() => null),
    ])
    if (schedData?.schedule) shared.betSchedule = schedData.schedule
    if (freshDaily?.pitchers) {
      shared.dailyPitchers = freshDaily.pitchers
      shared.dayPnl = freshDaily.day_pnl ?? shared.dayPnl
      try { await renderDaySummary(date, freshDaily) } catch {}
      const wlEl  = document.getElementById('day-wl')
      const pnlEl = document.getElementById('day-pnl-val')
      if (wlEl)  wlEl.textContent = `${freshDaily.day_wins}W · ${freshDaily.day_losses}L${freshDaily.day_pending > 0 ? ` · ${freshDaily.day_pending} pending` : ''}`
      if (pnlEl) {
        const cls = freshDaily.day_pnl >= 0 ? 'good' : 'bad'
        pnlEl.className = `day-pnl ${cls}`
        pnlEl.textContent = (freshDaily.day_pnl >= 0 ? '+' : '') + fmt$(freshDaily.day_pnl)
      }
    }
    shared.liveBetsPitchers = liveBetsData?.pitchers || []
    renderGameCards(shared.dailyPitchers, shared.liveBetsPitchers)
    renderTicker()
  } catch {}

  document.dispatchEvent(new CustomEvent('ks:refresh-bettors'))

  if (data.pitchers.length && data.pitchers.every(p => p.is_final)) {
    const anyPending = await fetchJson(`/api/ks/summary`).then(s => s.pending > 0).catch(() => false)
    if (anyPending) {
      try {
        const uid2 = state.currentUserId ?? null
        const r = await fetch('/api/ks/auto-settle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(uid2 ? { user_id: uid2 } : {}),
        })
        const settled = await r.json()
        if (settled.settled > 0) {
          const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
          await loadDay(todayDate)
        }
      } catch (e) { console.warn('[auto-settle] failed:', e.message) }
    } else {
      stopLivePolling()
    }
  }
}

// ── Pitcher card live update ────────────────────────────────────────────────

export function updatePitcherCardLive(p) {
  const card = document.querySelector(`.pitcher-card[data-pitcher-id="${CSS.escape(String(p.pitcher_id))}"]`)
  if (!card) return

  const isWarmup      = !p.is_final && p.pitches === 0 && p.ip === 0
  const hasLiveData   = p.ip > 0 && p.pitches > 0
  const hasEnoughData = hasLiveData && (p.ks > 0 || p.ip >= 2)
  const remLambda     = hasEnoughData ? remainingLambda(p.ks, p.ip, p.pitches) : null

  let projKs = null
  if (!p.is_final && hasEnoughData && remLambda != null) {
    projKs = Math.round((p.ks + remLambda) * 10) / 10
  }

  const scoreDiff = p.home_score != null && p.away_score != null
    ? Math.abs(p.home_score - p.away_score) : null
  const isBlowout = scoreDiff != null && scoreDiff >= 5 && !p.is_final

  const actualKsEl = card.querySelector('.pc-actual-ks')
  if (actualKsEl) {
    if (p.is_final) {
      actualKsEl.innerHTML = `<strong>${p.ks}</strong> Ks`
    } else if (!p.still_in) {
      actualKsEl.innerHTML = `<span class="pc-pulled-badge">PULLED</span> <strong>${p.ks}</strong> Ks`
    } else if (!isWarmup) {
      actualKsEl.innerHTML = `<strong>${p.ks}</strong> Ks`
    } else {
      actualKsEl.innerHTML = ''
    }
  }

  let liveRow = card.querySelector('.pc-live-row')
  if (!liveRow) {
    liveRow = document.createElement('div')
    liveRow.className = 'pc-live-row'
    card.querySelector('.pc-header-left')?.appendChild(liveRow)
  }

  if (p.is_postponed) {
    liveRow.innerHTML = `<span class="pc-live-chip postponed">🌧 Postponed</span>`
    return
  }

  if (p.is_final) {
    liveRow.innerHTML = `<span class="pc-live-chip final">Final · ${p.ip.toFixed(1)} IP</span>`
  } else if (!p.still_in) {
    liveRow.innerHTML = `<span class="pc-live-chip pulled">⚠ PULLED · ${p.ip.toFixed(1)} IP</span>`
  } else if (isWarmup) {
    liveRow.innerHTML = `<span class="pc-live-chip warmup">⚡ Warmup</span>`
  } else {
    const score  = p.home_score != null ? `${p.away_score}–${p.home_score}` : ''
    const parts  = [`${p.inning}`, `${p.ip.toFixed(1)} IP`, p.pitches ? `${p.pitches}p` : null, score || null]
      .filter(Boolean).join(' · ')
    const blowout = isBlowout ? ` <span class="pc-blowout-warn">⚠ blowout</span>` : ''
    const pace    = projKs != null ? `<span class="pc-pace-chip">proj <strong>${projKs}</strong> Ks</span>` : ''
    liveRow.innerHTML = `<span class="pc-live-chip live">${parts}${blowout}</span>${pace}`
  }

  const overallBar  = card.querySelector('.pc-overall-bar')
  const overallFill = card.querySelector('.pc-overall-fill')
  if (overallBar && !isWarmup) {
    overallBar.style.display = 'block'
  }

  for (const bs of p.bet_statuses) {
    const row = card.querySelector(`.pc-bet-row[data-bet-id="${bs.id}"]`)
    if (!row) continue
    const badge = row.querySelector('.pc-badge')
    if (!badge || !badge.classList.contains('pc-badge--pending')) continue
    const isNo = row.dataset.side === 'NO'

    const prog = row.querySelector('.pc-ks-progress')
    if (prog && !isWarmup) {
      prog.style.display = 'flex'
      const fill = prog.querySelector('.pc-ks-fill')
      const lbl  = prog.querySelector('.pc-ks-label')
      if (lbl) lbl.textContent = isNo ? `${bs.ks} Ks (need < ${bs.strike})` : `${bs.ks} / ${bs.strike} Ks`
      if (fill) fill.dataset.betId = bs.id
    }

    if (!isNo) {
      if (bs.needed === 0)       { badge.textContent = '✅ COVERED';                                           badge.className = 'pc-badge pc-badge--win pc-badge--covered' }
      else if (!p.still_in)      { badge.textContent = `❌ Out at ${bs.ks}K — needed ${bs.strike}`;            badge.className = 'pc-badge pc-badge--loss' }
      else if (bs.needed === 1)  { badge.textContent = `🔥 ${bs.ks} Ks — 1 MORE to win!`;                     badge.className = 'pc-badge pc-badge--oneaway' }
      else                       { badge.textContent = `Has ${bs.ks} — needs ${bs.strike} to win`;             badge.className = 'pc-badge' }
    } else {
      if (bs.ks >= bs.strike)    { badge.textContent = `❌ Hit ${bs.ks}K — needed to stay under ${bs.strike}`; badge.className = 'pc-badge pc-badge--loss' }
      else if (p.is_final)       { badge.textContent = `✅ Stayed under ${bs.strike} (${bs.ks}K)`;             badge.className = 'pc-badge pc-badge--win pc-badge--covered' }
      else if (!p.still_in)      { badge.textContent = `✅ Done at ${bs.ks}K — under ${bs.strike}`;            badge.className = 'pc-badge pc-badge--win pc-badge--covered' }
      else if (bs.ks === bs.strike - 1) { badge.textContent = `⚠️ At ${bs.ks}K — one more and we lose`;       badge.className = 'pc-badge pc-badge--oneaway' }
      else                       { badge.textContent = `At ${bs.ks}K — needs to stay under ${bs.strike}`;      badge.className = 'pc-badge' }
    }
  }

  let coverSum = 0, coverCount = 0
  for (const bs of p.bet_statuses) {
    const row = card.querySelector(`.pc-bet-row[data-bet-id="${bs.id}"]`)
    if (!row) continue
    const coverChip = row.querySelector('.pc-bet-cover')
    if (!coverChip) continue
    const isNo = row.dataset.side === 'NO'

    let prob
    if (p.is_final || !p.still_in) {
      prob = !isNo ? (bs.ks >= bs.strike ? 1 : 0) : (bs.ks < bs.strike ? 1 : 0)
    } else if (hasEnoughData && remLambda != null) {
      const needed = !isNo ? bs.strike - bs.ks : null
      prob = !isNo
        ? probAtLeast(needed, remLambda)
        : poissonCDF(bs.strike - bs.ks - 1, remLambda)
    } else {
      continue
    }

    const pct    = Math.round(prob * 100)
    const colCls = pct >= 60 ? 'good' : pct >= 40 ? 'warn' : 'bad'
    coverChip.textContent = `${pct}%`
    coverChip.className = `pc-bet-cover ${colCls}`

    const fill = row.querySelector('.pc-ks-fill')
    if (fill) {
      fill.style.width  = `${pct}%`
      fill.className    = `pc-ks-fill ${colCls}`
    }

    if (!bs.result) { coverSum += pct; coverCount++ }
  }

  const coverageEl = card.querySelector('.pc-coverage')
  if (coverageEl && coverCount > 0) {
    const avgPct = Math.round(coverSum / coverCount)
    const colCls = avgPct >= 60 ? 'good' : avgPct >= 40 ? 'warn' : 'bad'
    coverageEl.textContent = `${avgPct}% cover`
    coverageEl.className = `pc-coverage ${colCls}`
    card.dataset.coverage = avgPct
    if (overallFill) {
      overallFill.style.width = `${avgPct}%`
      overallFill.className   = `pc-overall-fill ${colCls}`
    }
  }
}

// ── Live banner ─────────────────────────────────────────────────────────────

export function buildLiveBanner(pitchers) {
  const banner = document.getElementById('live-banner')
  if (!banner) return
  if (!pitchers?.length) { banner.hidden = true; return }
  banner.hidden = false

  banner.className = 'live-now-panel'
  const sorted = [...pitchers].sort((a, b) => {
    if (a.game_time && b.game_time) return a.game_time.localeCompare(b.game_time)
    return a.pitcher_name.localeCompare(b.pitcher_name)
  })

  banner.innerHTML = `
    <div class="lnp-header">
      <span class="live-dot"></span>
      <span class="lnp-title">${pitchers.length} pitcher${pitchers.length !== 1 ? 's' : ''} today</span>
    </div>
    <div class="lnp-rows" id="lnp-rows">
      ${sorted.map(p => {
        const timeStr = fmtGameTime(p.game_time)
        const status  = timeStr ? `Game starts at ${timeStr}` : 'Warming up'
        return `<div class="lnp-row" data-pitcher-id="${p.pitcher_id || ''}" data-name="${esc(p.pitcher_name)}">
          <span class="lnp-name">${esc(p.pitcher_name)}</span>
          <span class="lnp-status lnp-pregame">${status}</span>
          <span class="lnp-jump">▸ bets</span>
        </div>`
      }).join('')}
    </div>`

  banner.querySelectorAll('.lnp-row').forEach(row => {
    row.addEventListener('click', () => scrollToPitcher(row.dataset.pitcherId, row.dataset.name))
  })
}

export function renderLiveBanner(data) {
  const banner = document.getElementById('live-banner')
  if (!banner || banner.hidden) return

  const liveNow = data.pitchers.filter(p => !p.is_final && p.ip > 0).length
  const titleEl = banner.querySelector('.lnp-title')
  if (titleEl) {
    titleEl.textContent = liveNow > 0
      ? `${liveNow} game${liveNow !== 1 ? 's' : ''} happening right now · ${data.pitchers.length} total today`
      : `${data.pitchers.length} pitcher${data.pitchers.length !== 1 ? 's' : ''} today`
  }

  for (const p of data.pitchers) {
    const row = p.pitcher_id
      ? banner.querySelector(`.lnp-row[data-pitcher-id="${p.pitcher_id}"]`)
      : null
    if (!row) continue
    const statusEl = row.querySelector('.lnp-status')
    if (!statusEl) continue

    const ksWord     = p.ks === 1 ? '1 strikeout' : `${p.ks} strikeouts`
    const sortedStrikes = p.bet_statuses?.length
      ? [...new Set(p.bet_statuses.map(bs => bs.strike))].sort((a, b) => a - b)
      : []
    const nextTarget = sortedStrikes.find(s => p.ks < s) ?? sortedStrikes[sortedStrikes.length - 1] ?? null

    if (p.is_final) {
      statusEl.textContent = `Final — threw ${ksWord}`
      statusEl.className   = 'lnp-status lnp-final'
    } else if (!p.still_in) {
      statusEl.textContent = `Out of the game — ${ksWord} (won't throw more)`
      statusEl.className   = 'lnp-status lnp-pulled'
    } else if (p.ip === 0) {
      const timeStr = fmtGameTime(p.game_time)
      statusEl.textContent = timeStr ? `Game starts at ${timeStr}` : 'Warming up'
      statusEl.className   = 'lnp-status lnp-pregame'
    } else {
      const ksDisplay = nextTarget != null ? `${p.ks}/${nextTarget} strikeouts` : ksWord
      statusEl.textContent = `${ksDisplay} · ${p.inning}`
      statusEl.className   = 'lnp-status lnp-live'
    }

    const card     = p.pitcher_id ? document.querySelector(`.pitcher-card[data-pitcher-id="${p.pitcher_id}"]`) : null
    const coverage = card ? Number(card.dataset.coverage || 0) : 0
    let verdictEl  = row.querySelector('.lnp-verdict')

    if (p.is_final || !p.still_in) {
      const wins = (p.bet_statuses || []).filter(bs =>
        bs.result === 'win' ||
        (!bs.result && (bs.side === 'NO' ? bs.ks < bs.strike : bs.ks >= bs.strike))
      ).length
      const didWin = wins > 0
      if (!verdictEl) {
        verdictEl = document.createElement('span')
        row.insertBefore(verdictEl, row.querySelector('.lnp-jump'))
      }
      verdictEl.textContent = didWin ? 'You win' : 'You lose'
      verdictEl.className   = `lnp-verdict ${didWin ? 'good' : 'bad'}`
    } else if (p.ip > 0 && coverage > 0) {
      if (!verdictEl) {
        verdictEl = document.createElement('span')
        row.insertBefore(verdictEl, row.querySelector('.lnp-jump'))
      }
      if (coverage >= 65)      { verdictEl.textContent = 'Looking good'; verdictEl.className = 'lnp-verdict good' }
      else if (coverage >= 40) { verdictEl.textContent = 'On track';     verdictEl.className = 'lnp-verdict' }
      else                     { verdictEl.textContent = 'Worried';      verdictEl.className = 'lnp-verdict bad' }
    } else if (verdictEl) {
      verdictEl.remove()
    }
  }
}

export function updateBannerChipColors(_pitchers) {
  // Coverage colors applied directly in renderLiveBanner — no-op kept for compat
}

// ── Scroll + flash helpers ──────────────────────────────────────────────────

export function scrollToPitcher(pid, name) {
  let card = pid ? document.querySelector(`.pitcher-card[data-pitcher-id="${CSS.escape(pid)}"]`) : null
  if (!card) {
    document.querySelectorAll('.pitcher-card').forEach(c => {
      if (c.querySelector('.pc-pitcher')?.textContent?.trim() === name) card = c
    })
  }
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' })
    card.classList.add('lb-highlight')
    setTimeout(() => card.classList.remove('lb-highlight'), 1500)
  }
}

export function flashPitcherCard(pitcherId, type, pitcherName) {
  const card = pitcherId
    ? document.querySelector(`.pitcher-card[data-pitcher-id="${CSS.escape(String(pitcherId))}"]`)
    : null
  if (card) {
    card.classList.remove('flash-win', 'flash-loss')
    void card.offsetWidth
    card.classList.add(`flash-${type}`)
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setTimeout(() => card.classList.remove(`flash-${type}`), 3500)
  }
  const name = pitcherName || 'Bet'
  const msg  = type === 'win' ? `✓ COVERED — ${name} just won!` : `✗ ${name} bet settled as a loss`
  showToast(msg, type)
}

export function showToast(message, type = 'win') {
  let toast = document.getElementById('cover-toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id        = 'cover-toast'
    toast.className = 'cover-toast'
    document.body.appendChild(toast)
  }
  toast.textContent = message
  toast.className   = `cover-toast cover-toast--${type} cover-toast--show`
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => toast.classList.remove('cover-toast--show'), 5000)
}
