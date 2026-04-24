import 'dotenv/config'
import http from 'node:http'
import * as db from '../../lib/db.js'
import { createKalshiWsClient } from '../../lib/kalshiWs.js'
import { applyFillEvent, applyOrderEvent, applyPositionEvent } from '../../lib/wsFillApplier.js'
import { forceSyncFillsForBettor } from '../../lib/ksFillSync.js'

const PORT = process.env.WS_HEALTH_PORT || process.env.PORT || 4001
const clients = []

async function main() {
  await db.migrate()

  const bettors = await db.all(
    `SELECT id, name, kalshi_key_id, kalshi_private_key
     FROM users
     WHERE active_bettor = 1
       AND kalshi_key_id IS NOT NULL
       AND id != 1`
  )

  if (!bettors.length) {
    console.log('[ws-daemon] no active bettors found — exiting')
    process.exit(0)
  }

  console.log(`[ws-daemon] found ${bettors.length} active bettor(s): ${bettors.map(b => b.name).join(', ')}`)

  // Cold-start REST sync
  for (const bettor of bettors) {
    console.log(`[ws-daemon] cold-start sync for ${bettor.name}...`)
    try {
      await forceSyncFillsForBettor(bettor)
      console.log(`[ws-daemon] cold-start sync complete for ${bettor.name}`)
    } catch (err) {
      console.error(`[ws-daemon] cold-start sync failed for ${bettor.name}:`, err.message)
    }
  }

  // Create WS clients
  for (const u of bettors) {
    const client = createKalshiWsClient({
      userId: u.id,
      name: u.name,
      keyId: u.kalshi_key_id,
      privateKey: u.kalshi_private_key,
      onEvent: (evt) => {
        if (evt.channel === 'fill') {
          applyFillEvent(u.id, evt.payload).catch(err =>
            console.error(`[ws ${u.name}] applyFillEvent error:`, err.message)
          )
        } else if (evt.channel === 'order_update') {
          applyOrderEvent(u.id, evt.payload).catch(err =>
            console.error(`[ws ${u.name}] applyOrderEvent error:`, err.message)
          )
        } else if (evt.channel === 'market_position') {
          applyPositionEvent(u.id, evt.payload).catch(err =>
            console.error(`[ws ${u.name}] applyPositionEvent error:`, err.message)
          )
        }
      },
      onStatus: (s) => {
        console.log(`[ws ${u.name}] ${s}`)
        if (s === 'subscribed') {
          forceSyncFillsForBettor(u).catch(err =>
            console.error(`[ws ${u.name}] post-subscribe sync error:`, err.message)
          )
        }
      },
    })

    clients.push({ name: u.name, client })
  }

  for (const { client } of clients) {
    client.connect()
  }

  // Health check HTTP server
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`)

    if (url.pathname === '/health') {
      const clientStats = clients.map(({ name, client }) => {
        const state = client.getState()
        const lastMsgAgoMs = client.lastMsgAt != null ? Date.now() - client.lastMsgAt : null
        return { name, state, lastMsgAgoMs }
      })

      const ok = clientStats.every(
        ({ state, lastMsgAgoMs }) =>
          state === 'subscribed' && (lastMsgAgoMs === null || lastMsgAgoMs < 5 * 60 * 1000)
      )

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok, clients: clientStats }))
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    }
  })

  server.listen(PORT, () => {
    console.log(`[ws-daemon] health endpoint on port ${PORT}`)
  })
}

async function shutdown() {
  console.log('[ws-daemon] shutting down...')
  for (const { client } of clients) client.close()
  await db.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch(err => {
  console.error('[ws-daemon] fatal:', err.message)
  process.exit(1)
})
