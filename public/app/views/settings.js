import { state } from '../state.js'
import { fmt$, esc, fmtDateFull } from '../utils.js'
import { fetchJson } from '../api.js'

export async function refreshSettings() {
  await loadUsers()
  wireAddUser()
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
        <label>Daily Risk %
          <input type="number" class="bf-risk" value="${Math.round((u.daily_risk_pct ?? 0.20) * 100)}" min="1" max="100"/>
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
  cancelBtn.addEventListener('click', () => {
    form.style.display = 'none'
    editBtn.textContent = 'Edit'
  })

  saveBtn.addEventListener('click', async () => {
    msg.className = 'form-msg'; msg.textContent = ''
    const body = {
      active_bettor:     wrap.querySelector('.bf-active').checked,
      paper:             wrap.querySelector('.bf-paper').value === '1',
      starting_bankroll: Number(wrap.querySelector('.bf-bankroll').value),
      daily_risk_pct:    Number(wrap.querySelector('.bf-risk').value) / 100,
      kalshi_key_id:     wrap.querySelector('.bf-keyid').value.trim() || null,
      discord_webhook:   wrap.querySelector('.bf-discord').value.trim() || null,
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
