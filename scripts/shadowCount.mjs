import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const a = await db.execute({ sql: `SELECT COUNT(*) AS n FROM shadow_inversion WHERE bet_date = ?`, args: [today] })
const b = await db.execute({ sql: `SELECT COUNT(*) AS n FROM shadow_calibrated_yes WHERE bet_date = ?`, args: [today] })
console.log(`shadow_inversion: ${a.rows[0].n}`)
console.log(`shadow_calibrated_yes: ${b.rows[0].n}`)
