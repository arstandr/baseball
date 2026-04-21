# KSBETS Feature Backlog

## Pending — build when model has 300-400 settled bets and edge is validated

### Mid-Game Hedge Calculator
Tracks open YES/NO positions during live games. Shows current Kalshi price vs. entry
price and calculates "sell now → lock in -$X" vs. "hold → expected value" for each
open bet. Flags when selling is the mathematically better play based on game state
(pitcher K count, innings remaining, pitch count).

**Why deferred:** Hedging kills edge if the pre-game signal is real. Bet sizing is the
better lever right now. Revisit once edge calibration is confirmed at scale.

---

## Ideas / Under Consideration

_(add future ideas here)_
