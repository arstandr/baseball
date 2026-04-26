import { createKalshiWsClient } from '../lib/kalshiWs.js'
import { applyFillEvent, applyOrderEvent, applyPositionEvent } from '../lib/wsFillApplier.js'
import { forceSyncFillsForBettor } from '../lib/ksFillSync.js'
import { reconcilePositionsForBettor } from '../lib/kalshiPositionSync.js'
import * as db from '../lib/db.js'

let _clients = []

export async function startWsDaemon() {
  const bettors = await db.all(
    `SELECT id, name, kalshi_key_id, kalshi_private_key
     FROM users
     WHERE active_bettor = 1
       AND kalshi_key_id IS NOT NULL
       AND id != 1`
  )

  if (!bettors.length) {
    console.log('[ws-daemon] no active bettors found — skipping')
    return []
  }

  console.log(`[ws-daemon] starting for ${bettors.length} bettor(s): ${bettors.map(b => b.name).join(', ')}`)

  for (const bettor of bettors) {
    try {
      await forceSyncFillsForBettor(bettor)
      reconcilePositionsForBettor(bettor).catch(() => {})
      console.log(`[ws-daemon] cold-start sync done for ${bettor.name}`)
    } catch (err) {
      console.error(`[ws-daemon] cold-start sync failed for ${bettor.name}:`, err.message)
    }
  }

  _clients = []
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
          reconcilePositionsForBettor(u).catch(() => {})
        }
      },
    })
    _clients.push({ name: u.name, client })
  }

  for (const { client } of _clients) client.connect()

  return _clients
}

export function getWsDaemonStatus() {
  return _clients.map(({ name, client }) => {
    const state = client.getState()
    const lastMsgAgoMs = client.lastMsgAt != null ? Date.now() - client.lastMsgAt : null
    return { name, state, lastMsgAgoMs }
  })
}

export function stopWsDaemon() {
  for (const { client } of _clients) client.close()
  _clients = []
}
