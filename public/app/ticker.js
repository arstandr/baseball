import { shared } from './state.js'
import { fmt$ } from './utils.js'

const TICKER_FILL_TTL = 30 * 60 * 1000

let _tickerLastHash = ''

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export function buildTickerItems() {
  const now   = Date.now()
  const today = todayET()
  const items = []

  // 1. Live K counts (active games only — disappear when final)
  for (const p of shared.dailyPitchers) {
    const live = shared.liveOverlay[String(p.pitcher_id)]
    if (!live || live.is_final) continue
    const ks = live.ks ?? 0
    const ip = live.ip != null ? ` · ${live.ip} IP` : ''
    items.push({ cls: 't-live', icon: '⚾', text: `${p.pitcher_name}  ${ks} K${ks !== 1 ? 's' : ''}${ip}` })
  }

  // 2. Settled results — today only, both clear at midnight
  for (const p of shared.dailyPitchers) {
    for (const b of (p.bets || [])) {
      if (!b.result) continue
      if (b.bet_date && b.bet_date !== today) continue
      const pnlStr = b.pnl != null ? ` ${b.pnl >= 0 ? '+' : ''}$${Math.abs(b.pnl).toFixed(2)}` : ''
      const label  = `${p.pitcher_name} ${b.side} ${b.strike}+`
      if (b.result === 'win') {
        items.push({ cls: 't-win',  icon: '✓', text: `${label} WON${pnlStr}` })
      } else {
        items.push({ cls: 't-loss', icon: '✗', text: `${label} LOST${pnlStr}` })
      }
    }
  }

  // 3. Recent fills (30 min)
  for (const p of shared.dailyPitchers) {
    for (const b of (p.bets || [])) {
      if (!b.filled_contracts || b.filled_contracts === 0) continue
      if (b.result) continue
      const age = b.filled_at ? now - new Date(b.filled_at).getTime() : Infinity
      if (age > TICKER_FILL_TTL) continue
      const priceStr = b.fill_price ? ` @ ${b.fill_price}¢` : ''
      items.push({ cls: 't-fill', icon: '●', text: `${p.pitcher_name} ${b.side} ${b.strike}+ filled — ${b.filled_contracts}c${priceStr}` })
    }
  }

  // 4. Upcoming scheduled bets (pending only, before their fire time)
  for (const s of (shared.betSchedule || [])) {
    const fireAt = new Date(s.scheduled_at)
    const minsUntil = Math.round((fireAt.getTime() - now) / 60000)
    if (minsUntil <= 0) continue  // already fired or past due — scheduler will clean it up
    const countdown = minsUntil >= 60
      ? `${Math.floor(minsUntil / 60)}h ${minsUntil % 60}m`
      : `${minsUntil}m`
    items.push({ cls: 't-schedule', icon: '⏰', text: `${s.pitcher_name}  ${s.game_label}  —  buying in ${countdown}` })
  }

  // 5. Day P&L — always pinned
  const settled = shared.dailyPitchers.flatMap(p => p.bets || []).filter(b => b.result)
  const wins    = settled.filter(b => b.result === 'win').length
  const losses  = settled.filter(b => b.result === 'loss').length
  const pending = shared.dailyPitchers.flatMap(p => p.bets || []).filter(b => !b.result && b.filled_contracts > 0).length
  const pnlSign = shared.dayPnl >= 0 ? '+' : ''
  const pnlCls  = shared.dayPnl >= 0 ? 't-win' : 't-loss'
  if (settled.length || pending) {
    items.push({ cls: `t-pnl ${pnlCls}`, icon: '💰', text: `Day P&L  ${pnlSign}$${Math.abs(shared.dayPnl).toFixed(2)}  ·  ${wins}W ${losses}L${pending ? `  · ${pending} live` : ''}` })
  }

  return items
}

export function triggerTickerNew() {
  const label = document.getElementById('ticker-label')
  if (!label) return
  label.textContent = '● NEW'
  label.classList.remove('ticker-new')
  label.offsetHeight
  label.classList.add('ticker-new')
  setTimeout(() => {
    label.textContent = 'LIVE'
    label.classList.remove('ticker-new')
  }, 3000)
}

export function renderTicker() {
  const wrap  = document.getElementById('ticker-wrap')
  const track = document.getElementById('ticker-track')
  if (!wrap || !track) return

  const items = buildTickerItems()
  if (!items.length) {
    wrap.style.display = 'none'
    return
  }
  wrap.style.display = 'flex'

  const hash    = items.map(i => i.text).join('|')
  const changed = hash !== _tickerLastHash
  _tickerLastHash = hash
  if (!changed) return

  triggerTickerNew()

  const html = [...items, ...items].map(it =>
    `<span class="ticker-item ${it.cls}"><span class="ticker-dot">■</span>${it.icon} ${it.text}</span>`
  ).join('')
  track.innerHTML = html

  const dur = Math.max(20, items.length * 8)
  track.style.setProperty('--ticker-dur', `${dur}s`)
  track.style.setProperty('--ticker-shift', '-50%')

  track.style.animation = 'none'
  track.offsetHeight
  track.style.animation = ''
}
