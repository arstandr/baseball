import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// For each candidate cap value, compute total NO P&L from bets that would fire (market_mid <= cap)
const r = await db.execute(`
  SELECT strike, market_mid, pnl, capital_at_risk
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days') AND live_bet = 0 AND side = 'NO'
    AND result IN ('win','loss') AND capital_at_risk > 0
`)
const rows = r.rows.map(x => ({...x, market_mid: Number(x.market_mid ?? 50), pnl: Number(x.pnl ?? 0), strike: Number(x.strike)}))

console.log('cap   strikes_3-5_pnl   strike_6_pnl   strike_7+_pnl    total_pnl    bets')
console.log('─'.repeat(85))
for (const cap of [50, 55, 60, 65, 70, 75, 80, 100]) {
  const fire = rows.filter(r => r.market_mid <= cap)
  const p35 = fire.filter(r => r.strike >= 3 && r.strike <= 5).reduce((s,r)=>s+r.pnl, 0)
  const p6  = fire.filter(r => r.strike === 6).reduce((s,r)=>s+r.pnl, 0)
  const p7p = fire.filter(r => r.strike >= 7).reduce((s,r)=>s+r.pnl, 0)
  const tot = p35 + p6 + p7p
  console.log(`${String(cap).padEnd(5)}   ${('+$'+p35.toFixed(2)).padStart(13)}   ${(p6 >= 0 ? '+$' : '-$') + Math.abs(p6).toFixed(2).padStart(8)}   ${(p7p >= 0 ? '+$' : '-$') + Math.abs(p7p).toFixed(2).padStart(8)}    ${(tot >= 0 ? '+$' : '-$') + Math.abs(tot).toFixed(2).padStart(8)}    ${fire.length}`)
}

// Bonus: per-strike at the proposed 65 cap
console.log('\n── At cap=65, per-strike breakdown ──')
const cap = 65
const fire = rows.filter(r => r.market_mid <= cap)
const block = rows.filter(r => r.market_mid > cap)
const byStrike = new Map()
for (const r of fire) {
  if (!byStrike.has(r.strike)) byStrike.set(r.strike, { fire: 0, block: 0, fp: 0, bp: 0 })
  const e = byStrike.get(r.strike); e.fire++; e.fp += r.pnl
}
for (const r of block) {
  if (!byStrike.has(r.strike)) byStrike.set(r.strike, { fire: 0, block: 0, fp: 0, bp: 0 })
  const e = byStrike.get(r.strike); e.block++; e.bp += r.pnl
}
for (const [k, v] of [...byStrike.entries()].sort()) {
  console.log(`  K${k}  fire=${v.fire} (${v.fp >= 0 ? '+' : ''}$${v.fp.toFixed(2)})   block=${v.block} (${v.bp >= 0 ? '+' : ''}$${v.bp.toFixed(2)})`)
}
