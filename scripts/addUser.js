// scripts/addUser.js — Add or remove users from the CLI
//
// Usage:
//   node scripts/addUser.js --add --name Isaiah --pin 1234
//   node scripts/addUser.js --remove --name Isaiah
//   node scripts/addUser.js --list

import 'dotenv/config'
import * as db from '../lib/db.js'

const args = process.argv.slice(2)

async function main() {
  await db.migrate()

  if (args.includes('--list')) {
    const users = await db.all(`SELECT id, name, created_at FROM users ORDER BY created_at`)
    if (!users.length) { console.log('No users configured.'); return }
    console.log('\nUsers:')
    for (const u of users) console.log(`  ${u.id}. ${u.name}  (added ${u.created_at})`)
    console.log()
    return
  }

  if (args.includes('--add')) {
    const name = args[args.indexOf('--name') + 1]
    const pin  = args[args.indexOf('--pin')  + 1]
    if (!name || !pin) { console.error('Usage: --add --name <name> --pin <pin>'); process.exit(1) }
    if (String(pin).length < 4) { console.error('PIN must be at least 4 digits.'); process.exit(1) }
    try {
      await db.run(`INSERT INTO users (name, pin) VALUES (?, ?)`, [name.trim(), pin.trim()])
      console.log(`User "${name}" added successfully.`)
    } catch (err) {
      if (err.message?.includes('UNIQUE')) console.error(`User "${name}" already exists.`)
      else throw err
    }
    return
  }

  if (args.includes('--remove')) {
    const name = args[args.indexOf('--name') + 1]
    if (!name) { console.error('Usage: --remove --name <name>'); process.exit(1) }
    await db.run(`DELETE FROM users WHERE name = ? COLLATE NOCASE`, [name.trim()])
    console.log(`User "${name}" removed.`)
    return
  }

  console.log('Usage:')
  console.log('  node scripts/addUser.js --list')
  console.log('  node scripts/addUser.js --add --name <name> --pin <pin>')
  console.log('  node scripts/addUser.js --remove --name <name>')
}

main().then(() => db.close()).catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
