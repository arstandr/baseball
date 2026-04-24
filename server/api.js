// server/api.js — route orchestration shim.
// All routes have been split into focused modules; this file just mounts them.
//
// Route layout:
//   server/sse.js                  → /events, /meta
//   server/routes/games.js         → /summary, /games/*, /trades, /calibration, /backtest/*
//   server/routes/ks-live.js       → /ks/live, /ks/live-bets
//   server/routes/ks-analytics.js  → /ks/summary, /ks/bettors, /ks/daily, /ks/stats, …
//   server/routes/ks-kalshi.js     → /ks/balance, /ks/candles, /ks/market-prices, /ks/kalshi-positions
//   server/routes/users.js         → /users/*, /agent/status

import express from 'express'
import sseRouter        from './sse.js'
import gamesRouter      from './routes/games.js'
import ksLiveRouter     from './routes/ks-live.js'
import ksAnalyticsRouter from './routes/ks-analytics.js'
import ksKalshiRouter   from './routes/ks-kalshi.js'
import usersRouter      from './routes/users.js'

const router = express.Router()

router.use(sseRouter)
router.use(gamesRouter)
router.use(ksLiveRouter)
router.use(ksAnalyticsRouter)
router.use(ksKalshiRouter)
router.use(usersRouter)

export default router
