import { state } from '../state.js'
import { fmt$, esc, fmtDateFull } from '../utils.js'
import { fetchJson } from '../api.js'

export async function refreshSettings() {
  await loadUsers()
  wireAddUser()
  await loadRules()
}

async function loadUsers() {
  const users = await fetchJson('/api/users').catch(() => [])
  const list = document.getElementById('user-list')
  list.innerHTML = ''
  if (!users.length) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px 0;">No users yet.</div>'
    return
  }
  for (const u of users) {
    const isMe = u.name.toLowerCase() === state.currentUser?.toLowerCase()
    list.appendChild(buildUserCard(u, isMe))
  }
}

function buildUserCard(u, isMe) {
  const bettorBadge = u.active_bettor
    ? (u.paper ? '<span class="u-badge paper">PAPER</span>' : '<span class="u-badge live">LIVE</span>')
    : ''
  const keyStatus = u.has_kalshi_key
    ? '<span class="u-keychip ok">key ✓</span>'
    : '<span class="u-keychip miss">no key</span>'

  const wrap = document.createElement('div')
  wrap.className = 'user-item-wrap'
  wrap.innerHTML = `
    <div class="user-item">
      <div>
        <div class="u-name">${esc(u.name)}${isMe ? ' <span class="u-you">(you)</span>' : ''} ${bettorBadge}</div>
        <div class="u-since">Added ${fmtDateFull(u.created_at?.slice(0, 10) || '')} ${u.active_bettor ? '· ' + keyStatus : ''}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="u-edit filter-btn secondary">Edit</button>
        ${isMe ? '' : `<button class="u-del">Remove</button>`}
      </div>
    </div>
    <div class="u-bettor-form" style="display:none">
      <div class="bettor-form-grid">
        <label>Active Bettor
          <input type="checkbox" class="bf-active" ${u.active_bettor ? 'checked' : ''}/>
        </label>
        <label>Mode
          <select class="bf-paper">
            <option value="1" ${u.paper !== 0 ? 'selected' : ''}>Paper</option>
            <option value="0" ${u.paper === 0 ? 'selected' : ''}>Live</option>
          </select>
        </label>
        <label>Starting Bankroll ($)
          <input type="number" class="bf-bankroll" value="${u.starting_bankroll ?? 5000}" min="100" step="100"/>
        </label>
        <label style="grid-column:1/-1">
          <span style="font-size:12px;color:var(--text-dim)">Budget Split — must sum to 100%</span>
          <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
            <label style="flex:1;font-size:12px">Pre-game %
              <input type="number" class="bf-pregame" value="${Math.round((u.pregame_risk_pct ?? 0.60) * 100)}" min="1" max="98" style="width:100%"/>
            </label>
            <label style="flex:1;font-size:12px">In-game %
              <input type="number" class="bf-live" value="${Math.round((u.live_daily_risk_pct ?? 0.20) * 100)}" min="1" max="98" style="width:100%"/>
            </label>
            <label style="flex:1;font-size:12px">Free Money %
              <input type="number" class="bf-freemoney" value="${Math.round((u.free_money_risk_pct ?? 0.20) * 100)}" min="1" max="98" style="width:100%"/>
            </label>
          </div>
          <div class="bf-split-sum" style="font-size:11px;margin-top:3px;color:var(--text-dim)">Sum: <span class="bf-split-val">100</span>%</div>
        </label>
      </div>
      <label class="bf-label-full">Kalshi Key ID
        <input type="text" class="bf-keyid" value="${esc(u.kalshi_key_id || '')}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off"/>
      </label>
      <label class="bf-label-full">Kalshi Private Key (RSA PEM) ${u.has_kalshi_key ? '<span class="u-keychip ok">saved</span>' : ''}
        <textarea class="bf-pem" rows="4" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...paste full PEM here...&#10;-----END RSA PRIVATE KEY-----" autocomplete="off"></textarea>
        <span class="bf-pem-hint">Leave blank to keep existing key.</span>
      </label>
      <label class="bf-label-full">Discord Webhook URL (optional)
        <input type="text" class="bf-discord" value="${esc(u.discord_webhook || '')}" placeholder="https://discord.com/api/webhooks/…" autocomplete="off"/>
      </label>
      <label class="bf-label-full">Daily Loss Limit ($, optional — overrides global default)
        <input type="number" class="bf-losslimit" value="${u.daily_loss_limit ?? ''}" placeholder="e.g. 300 — leave blank to use system default" min="0" step="50"/>
      </label>
      <label class="bf-label-full" style="font-size:11px;color:var(--text-dim)">
        Closer Agent — set <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px">BETTOR_USER_ID=${u.id}</code> in the Windows .env to tag this user's heartbeat
      </label>
      <label class="bf-label-full">Change PIN (leave blank to keep)
        <input type="password" class="bf-pin" placeholder="New PIN (4+ digits)" maxlength="10" inputmode="numeric" autocomplete="new-password"/>
      </label>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="u-save filter-btn">Save</button>
        <button class="u-cancel filter-btn secondary">Cancel</button>
      </div>
      <div class="form-msg bf-msg"></div>
    </div>`

  const editBtn   = wrap.querySelector('.u-edit')
  const form      = wrap.querySelector('.u-bettor-form')
  const saveBtn   = wrap.querySelector('.u-save')
  const cancelBtn = wrap.querySelector('.u-cancel')
  const delBtn    = wrap.querySelector('.u-del')
  const msg       = wrap.querySelector('.bf-msg')

  editBtn.addEventListener('click', () => {
    const open = form.style.display !== 'none'
    form.style.display = open ? 'none' : 'block'
    editBtn.textContent = open ? 'Edit' : 'Close'
  })

  // Live sum display for the three pool % inputs
  const splitInputs = [wrap.querySelector('.bf-pregame'), wrap.querySelector('.bf-live'), wrap.querySelector('.bf-freemoney')]
  const splitVal    = wrap.querySelector('.bf-split-val')
  const splitSumEl  = wrap.querySelector('.bf-split-sum')
  function updateSplitSum() {
    const sum = splitInputs.reduce((s, el) => s + (Number(el.value) || 0), 0)
    splitVal.textContent = sum
    splitSumEl.style.color = sum === 100 ? 'var(--green, #4caf50)' : 'var(--red, #f44336)'
  }
  splitInputs.forEach(el => el.addEventListener('input', updateSplitSum))
  updateSplitSum()
  cancelBtn.addEventListener('click', () => {
    form.style.display = 'none'
    editBtn.textContent = 'Edit'
  })

  saveBtn.addEventListener('click', async () => {
    msg.className = 'form-msg'; msg.textContent = ''
    const pregamePct   = Number(wrap.querySelector('.bf-pregame').value) || 0
    const livePct      = Number(wrap.querySelector('.bf-live').value) || 0
    const freeMoneyPct = Number(wrap.querySelector('.bf-freemoney').value) || 0
    const splitSum     = pregamePct + livePct + freeMoneyPct
    if (splitSum !== 100) {
      msg.className = 'form-msg err'; msg.textContent = `Budget split must sum to 100% (currently ${splitSum}%).`; return
    }
    const body = {
      active_bettor:       wrap.querySelector('.bf-active').checked,
      paper:               wrap.querySelector('.bf-paper').value === '1',
      starting_bankroll:   Number(wrap.querySelector('.bf-bankroll').value),
      pregame_risk_pct:    pregamePct / 100,
      live_daily_risk_pct: livePct / 100,
      free_money_risk_pct: freeMoneyPct / 100,
      kalshi_key_id:       wrap.querySelector('.bf-keyid').value.trim() || null,
      discord_webhook:     wrap.querySelector('.bf-discord').value.trim() || null,
      daily_loss_limit:    wrap.querySelector('.bf-losslimit').value.trim() || '',
    }
    const pem = wrap.querySelector('.bf-pem').value.trim()
    if (pem) body.kalshi_private_key = pem
    const pin = wrap.querySelector('.bf-pin').value.trim()
    if (pin) {
      if (pin.length < 4) { msg.className = 'form-msg err'; msg.textContent = 'PIN must be at least 4 digits.'; return }
      body.pin = pin
    }
    try {
      const r = await fetch(`/api/users/${u.id}`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) { msg.className = 'form-msg err'; msg.textContent = d.error || 'Error'; return }
      msg.className = 'form-msg ok'; msg.textContent = 'Saved.'
      setTimeout(() => { msg.textContent = ''; form.style.display = 'none'; editBtn.textContent = 'Edit' }, 1500)
      await loadUsers()
    } catch { msg.className = 'form-msg err'; msg.textContent = 'Network error.' }
  })

  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Remove user "${u.name}"?`)) return
      await fetchJson(`/api/users/${encodeURIComponent(u.name)}`, { method: 'DELETE' }).catch(() => null)
      await loadUsers()
    })
  }
  return wrap
}

function wireAddUser() {
  const btn = document.getElementById('add-user-btn')
  if (btn.dataset.wired) return
  btn.dataset.wired = '1'
  btn.addEventListener('click', async () => {
    const name = document.getElementById('new-name').value.trim()
    const pin  = document.getElementById('new-pin').value.trim()
    const msg  = document.getElementById('add-user-msg')
    msg.className = 'form-msg'
    msg.textContent = ''
    if (!name || !pin) { msg.className = 'form-msg err'; msg.textContent = 'Name and PIN required.'; return }
    if (pin.length < 4) { msg.className = 'form-msg err'; msg.textContent = 'PIN must be at least 4 digits.'; return }
    try {
      const r = await fetch('/api/users', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, pin }),
      })
      const d = await r.json()
      if (!r.ok) { msg.className = 'form-msg err'; msg.textContent = d.error || 'Error'; return }
      document.getElementById('new-name').value = ''
      document.getElementById('new-pin').value  = ''
      msg.className = 'form-msg ok'; msg.textContent = `User "${name}" added.`
      setTimeout(() => msg.textContent = '', 3000)
      await loadUsers()
    } catch { msg.className = 'form-msg err'; msg.textContent = 'Network error.' }
  })
}

// ── Betting Rules ─────────────────────────────────────────────────────────────

async function loadRules() {
  const el = document.getElementById('rules-container')
  if (!el) return
  try {
    const { rules } = await fetchJson('/api/ks/rules')
    renderRules(el, rules)
  } catch {
    el.innerHTML = '<div class="muted" style="padding:12px">Unable to load betting rules.</div>'
  }
}

function renderRules(el, rules) {
  if (!rules?.length) {
    el.innerHTML = '<div class="muted" style="padding:12px">No rules configured.</div>'
    return
  }
  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="color:var(--text-dim);text-align:left">
        <th style="padding:8px 0">Rule</th>
        <th style="padding:8px;text-align:right">Current</th>
        <th style="padding:8px;text-align:right">Default</th>
        <th style="padding:8px;text-align:right">Last updated</th>
        <th style="padding:8px;text-align:right">Actions</th>
      </tr></thead>
      <tbody>
        ${rules.map(r => {
          const isModified = r.value !== r.default_val
          const ago = r.updated_at ? _fmtRuleAgo(r.updated_at) : '—'
          const updater = r.updated_by && r.updated_by !== 'default' ? ` by ${r.updated_by}` : ''
          const valDisplay = Number.isInteger(r.value) ? r.value : r.value?.toFixed(2)
          const defDisplay = Number.isInteger(r.default_val) ? r.default_val : r.default_val?.toFixed(2)
          return `<tr style="border-top:1px solid rgba(255,255,255,0.06)" data-rule-key="${esc(r.key)}">
            <td style="padding:8px 0">
              <div style="font-weight:600">${esc(r.label || r.key)}</div>
              <div style="color:var(--text-dim);font-size:11px;margin-top:2px">${esc(r.description || '')}</div>
            </td>
            <td style="padding:8px;text-align:right">
              <input class="rule-val-input" value="${valDisplay}" style="width:72px;text-align:right;background:var(--card-bg);border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:var(--text);padding:4px 6px;font-size:13px" />
            </td>
            <td style="padding:8px;text-align:right;color:var(--text-dim)">${defDisplay}</td>
            <td style="padding:8px;text-align:right;color:var(--text-dim);font-size:11px">${ago}${updater}</td>
            <td style="padding:8px;text-align:right;display:flex;gap:6px;justify-content:flex-end">
              <button class="rule-save-btn filter-btn" style="font-size:11px;padding:3px 8px">Save</button>
              ${isModified ? `<button class="rule-reset-btn filter-btn secondary" style="font-size:11px;padding:3px 8px">Reset</button>` : ''}
            </td>
          </tr>`
        }).join('')}
      </tbody>
    </table>`

  el.querySelectorAll('tr[data-rule-key]').forEach(row => {
    const key      = row.dataset.ruleKey
    const input    = row.querySelector('.rule-val-input')
    const saveBtn  = row.querySelector('.rule-save-btn')
    const resetBtn = row.querySelector('.rule-reset-btn')

    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const val = parseFloat(input.value)
      if (isNaN(val)) return
      saveBtn.disabled = true
      saveBtn.textContent = '…'
      try {
        await fetchJson(`/api/ks/rules/${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: val }),
        })
        saveBtn.textContent = '✓'
        setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.disabled = false; loadRules() }, 800)
      } catch {
        saveBtn.textContent = 'Error'
        setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.disabled = false }, 1500)
      }
    })

    if (resetBtn) resetBtn.addEventListener('click', async () => {
      resetBtn.disabled = true
      await fetchJson(`/api/ks/rules/${encodeURIComponent(key)}/reset`, { method: 'POST' }).catch(() => {})
      loadRules()
    })
  })
}

function _fmtRuleAgo(ts) {
  if (!ts) return '—'
  const d   = new Date(ts.endsWith('Z') ? ts : ts + 'Z')
  const now = new Date()
  const m   = Math.round((now - d) / 60000)
  if (m < 2) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.round(m / 60)}h ago`
  return `${Math.round(m / 1440)}d ago`
}
