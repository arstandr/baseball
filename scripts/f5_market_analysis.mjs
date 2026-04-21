// F5 Market Comprehensive Analysis
// Fetches all open F5 and full-game markets, matches by game,
// computes ratios, spreads, depth, and liquidity metrics.

import * as k from '../lib/kalshi.js'

// ---- helpers ----
function parseGameKey(eventTicker) {
  // KXMLBF5TOTAL-26APR191420NYMCHC  or  KXMLBTOTAL-26APR191420NYMCHC
  // Extract just the date+time+teams portion
  const m = eventTicker.match(/(?:KXMLBF5TOTAL|KXMLBTOTAL)-(.+)/)
  return m ? m[1] : eventTicker
}

function parseCents(dolStr) {
  if (dolStr == null) return null
  const n = typeof dolStr === 'string' ? parseFloat(dolStr) : dolStr
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

function median(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

function mean(arr) {
  if (!arr.length) return null
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function stddev(arr) {
  if (arr.length < 2) return null
  const mu = mean(arr)
  return Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length)
}

// ---- fetch ----
console.log('=== Fetching F5 markets (KXMLBF5TOTAL) ===')
const f5Res = await k.listMarkets({ seriesTicker: 'KXMLBF5TOTAL', limit: 200, status: 'open' })
const f5Markets = f5Res?.markets || []
console.log(`Total F5 markets fetched: ${f5Markets.length}`)

console.log('\n=== Fetching full-game markets (KXMLBTOTAL) ===')
const fgRes = await k.listMarkets({ seriesTicker: 'KXMLBTOTAL', limit: 200, status: 'open' })
const fgMarkets = fgRes?.markets || []
console.log(`Total full-game markets fetched: ${fgMarkets.length}`)

// ---- group F5 by game ----
const f5ByGame = {}
for (const m of f5Markets) {
  const gk = parseGameKey(m.event_ticker)
  if (!f5ByGame[gk]) f5ByGame[gk] = []
  f5ByGame[gk].push(m)
}

// ---- group full-game by game ----
const fgByGame = {}
for (const m of fgMarkets) {
  const gk = parseGameKey(m.event_ticker)
  if (!fgByGame[gk]) fgByGame[gk] = []
  fgByGame[gk].push(m)
}

const f5Games = Object.keys(f5ByGame)
const fgGames = new Set(Object.keys(fgByGame))

console.log(`\nUnique games with F5 markets: ${f5Games.length}`)
console.log(`Unique games with full-game markets: ${fgGames.size}`)

// ---- per-game analysis ----
const gameResults = []
const spreadCents = []
const bidSizes = []
const askSizes = []
const altLineCounts = []
const f5Ratios = []
const colRatios = []   // Coors (COL) park
const nonColRatios = []

for (const gk of f5Games) {
  const f5List = f5ByGame[gk]
  const fgList = fgByGame[gk] || []

  // Sort F5 by floor_strike
  f5List.sort((a, b) => Number(a.floor_strike) - Number(b.floor_strike))

  // Alt lines available
  const strikes = f5List.map(m => Number(m.floor_strike))
  altLineCounts.push(strikes.length)

  // Main F5 line: floor_strike closest to 4.5
  const main = f5List.reduce((best, m) => {
    return Math.abs(Number(m.floor_strike) - 4.5) < Math.abs(Number(best.floor_strike) - 4.5) ? m : best
  }, f5List[0])

  const f5Line = Number(main.floor_strike)
  const yes_ask = parseCents(main.yes_ask_dollars)
  const yes_bid = parseCents(main.yes_bid_dollars)
  const spread = (yes_ask != null && yes_bid != null) ? yes_ask - yes_bid : null
  if (spread != null) spreadCents.push(spread)

  const yaSize = main.yes_ask_size_fp != null ? Number(main.yes_ask_size_fp) : null
  const ybSize = main.yes_bid_size_fp  != null ? Number(main.yes_bid_size_fp) : null
  if (yaSize != null) askSizes.push(yaSize)
  if (ybSize != null) bidSizes.push(ybSize)

  // Full-game matching line: floor_strike closest to (f5Line + 4)
  // The typical ratio target: F5 total ~ 55-60% of full game total
  // We want the full-game market nearest to f5Line / 0.55 ≈ f5Line * 1.82
  let fgLine = null
  let fgMarket = null
  if (fgList.length > 0) {
    // Use 7.5 as anchor first (typical full-game line), then closest
    const target = f5Line + 4.0  // rough offset heuristic
    fgMarket = fgList.reduce((best, m) => {
      return Math.abs(Number(m.floor_strike) - target) < Math.abs(Number(best.floor_strike) - target) ? m : best
    }, fgList[0])
    fgLine = Number(fgMarket.floor_strike)
  }

  const ratio = (fgLine != null && fgLine > 0) ? f5Line / fgLine : null
  if (ratio != null) f5Ratios.push(ratio)

  // Coors flag (COL home or away)
  const isCoors = gk.includes('COL')

  if (ratio != null) {
    if (isCoors) colRatios.push(ratio)
    else nonColRatios.push(ratio)
  }

  gameResults.push({
    game: gk,
    f5_main_line: f5Line,
    f5_lines_available: strikes,
    fg_closest_line: fgLine,
    ratio: ratio != null ? ratio.toFixed(4) : null,
    yes_ask_cents: yes_ask,
    yes_bid_cents: yes_bid,
    spread_cents: spread,
    yes_ask_size: yaSize,
    yes_bid_size: ybSize,
    volume: main.volume_fp != null ? Number(main.volume_fp) : null,
    is_coors: isCoors,
  })
}

// ---- aggregate stats ----
const ratioMean   = mean(f5Ratios)
const ratioMedian = median(f5Ratios)
const ratioStd    = stddev(f5Ratios)
const ratioMin    = f5Ratios.length ? Math.min(...f5Ratios) : null
const ratioMax    = f5Ratios.length ? Math.max(...f5Ratios) : null

const spreadMean   = mean(spreadCents)
const spreadMedian = median(spreadCents)

const avgAskSize = mean(askSizes)
const avgBidSize = mean(bidSizes)

const altLineMin = altLineCounts.length ? Math.min(...altLineCounts) : null
const altLineMax = altLineCounts.length ? Math.max(...altLineCounts) : null
const altLineMed = median(altLineCounts)

// All unique floor_strike values across all F5 markets
const allStrikes = new Set(f5Markets.map(m => Number(m.floor_strike)))

// ---- print per-game table ----
console.log('\n=== PER-GAME F5 ANALYSIS ===')
console.log(`${'GAME'.padEnd(30)} ${'F5_LINE'.padStart(7)} ${'FG_LINE'.padStart(7)} ${'RATIO'.padStart(7)} ${'SPREAD'.padStart(7)} ${'ASK_SZ'.padStart(8)} ${'BID_SZ'.padStart(8)} ${'VOLUME'.padStart(9)} ${'ALT_N'.padStart(6)} ${'LINES'}`)
console.log('-'.repeat(120))
for (const g of gameResults) {
  console.log(
    g.game.padEnd(30),
    String(g.f5_main_line).padStart(7),
    String(g.fg_closest_line ?? 'N/A').padStart(7),
    (g.ratio ?? 'N/A').toString().padStart(7),
    (g.spread_cents != null ? g.spread_cents + '¢' : 'N/A').padStart(7),
    (g.yes_ask_size != null ? g.yes_ask_size.toFixed(0) : 'N/A').padStart(8),
    (g.yes_bid_size != null ? g.yes_bid_size.toFixed(0) : 'N/A').padStart(8),
    (g.volume != null ? g.volume.toFixed(0) : 'N/A').padStart(9),
    String(g.f5_lines_available.length).padStart(6),
    '[' + g.f5_lines_available.join(', ') + ']' + (g.is_coors ? ' 🏔 COORS' : '')
  )
}

// ---- summary ----
console.log('\n' + '='.repeat(70))
console.log('=== SUMMARY STATISTICS ===')
console.log('='.repeat(70))

console.log(`\n--- F5 / Full-Game Line Ratio (using closest lines) ---`)
console.log(`  Matched games:    ${f5Ratios.length} / ${f5Games.length}`)
console.log(`  Mean ratio:       ${ratioMean?.toFixed(4)}`)
console.log(`  Median ratio:     ${ratioMedian?.toFixed(4)}`)
console.log(`  Std deviation:    ${ratioStd?.toFixed(4)}`)
console.log(`  Min ratio:        ${ratioMin?.toFixed(4)}`)
console.log(`  Max ratio:        ${ratioMax?.toFixed(4)}`)

console.log(`\n--- Park Effects (Coors vs Non-Coors) ---`)
if (colRatios.length > 0) {
  console.log(`  COL games:        ${colRatios.length}  |  Mean ratio: ${mean(colRatios)?.toFixed(4)}  |  Values: ${colRatios.map(r => r.toFixed(3)).join(', ')}`)
} else {
  console.log(`  No COL (Coors) games in today's slate`)
}
if (nonColRatios.length > 0) {
  console.log(`  Non-COL games:    ${nonColRatios.length}  |  Mean ratio: ${mean(nonColRatios)?.toFixed(4)}`)
}

console.log(`\n--- Bid-Ask Spread (F5 markets, main line ~4.5) ---`)
console.log(`  Mean spread:      ${spreadMean?.toFixed(1)}¢`)
console.log(`  Median spread:    ${spreadMedian?.toFixed(1)}¢`)
console.log(`  Min spread:       ${spreadCents.length ? Math.min(...spreadCents) : 'N/A'}¢`)
console.log(`  Max spread:       ${spreadCents.length ? Math.max(...spreadCents) : 'N/A'}¢`)

console.log(`\n--- Book Depth at Best Price (F5 main line, yes side) ---`)
console.log(`  Avg ask depth:    ${avgAskSize?.toFixed(0)} contracts`)
console.log(`  Avg bid depth:    ${avgBidSize?.toFixed(0)} contracts`)
console.log(`  Min ask depth:    ${askSizes.length ? Math.min(...askSizes).toFixed(0) : 'N/A'}`)
console.log(`  Max ask depth:    ${askSizes.length ? Math.max(...askSizes).toFixed(0) : 'N/A'}`)

console.log(`\n--- Alt Lines Available per Game ---`)
console.log(`  Min lines:        ${altLineMin}`)
console.log(`  Max lines:        ${altLineMax}`)
console.log(`  Median lines:     ${altLineMed}`)
console.log(`  All unique strikes across all F5 markets: [${[...allStrikes].sort((a,b)=>a-b).join(', ')}]`)

console.log(`\n--- F5 Market Coverage ---`)
console.log(`  Games with F5 markets today: ${f5Games.length}`)
console.log(`  Games with full-game markets today: ${fgGames.size}`)
console.log(`  Games matched (both F5 + FG): ${f5Ratios.length}`)
console.log(`  Total F5 market contracts (open markets): ${f5Markets.length}`)

// ---- full-game lines distribution ----
const fgLinesByGame = {}
for (const gk of f5Games) {
  const fgList = fgByGame[gk] || []
  fgLinesByGame[gk] = fgList.map(m => Number(m.floor_strike)).sort((a,b) => a-b)
}
console.log(`\n--- Full-game line ranges per matched game ---`)
for (const [gk, lines] of Object.entries(fgLinesByGame)) {
  if (lines.length) console.log(`  ${gk.padEnd(30)} FG lines: [${lines.join(', ')}]`)
}

// ---- detailed F5 spread distribution across all lines ----
console.log(`\n--- Spread by F5 Line (all markets) ---`)
const spreadByLine = {}
for (const m of f5Markets) {
  const line = Number(m.floor_strike)
  const ya = parseCents(m.yes_ask_dollars)
  const yb = parseCents(m.yes_bid_dollars)
  const sp = (ya != null && yb != null) ? ya - yb : null
  if (sp != null) {
    if (!spreadByLine[line]) spreadByLine[line] = []
    spreadByLine[line].push(sp)
  }
}
for (const line of [...Object.keys(spreadByLine)].map(Number).sort((a,b)=>a-b)) {
  const sp = spreadByLine[line]
  console.log(`  Line ${String(line).padEnd(4)}: mean=${mean(sp)?.toFixed(1)}¢  median=${median(sp)?.toFixed(1)}¢  n=${sp.length}`)
}

// ---- volume distribution ----
const volumes = f5Markets.map(m => m.volume_fp != null ? Number(m.volume_fp) : null).filter(v => v != null)
console.log(`\n--- F5 Volume Distribution (all open markets) ---`)
console.log(`  Total markets:    ${volumes.length}`)
console.log(`  Mean volume:      ${mean(volumes)?.toFixed(1)}`)
console.log(`  Median volume:    ${median(volumes)?.toFixed(1)}`)
console.log(`  Max volume:       ${volumes.length ? Math.max(...volumes).toFixed(0) : 'N/A'}`)
const zero = volumes.filter(v => v === 0).length
console.log(`  Zero-volume mkts: ${zero} (${(zero/volumes.length*100).toFixed(0)}%)`)

console.log('\n' + '='.repeat(70))
console.log('=== KEY NUMBERS FOR BACKTEST VALIDATION ===')
console.log('='.repeat(70))
console.log(`  F5/FG line ratio (median):     ${ratioMedian?.toFixed(4)}   <- use as F5_RATIO_FACTOR`)
console.log(`  F5/FG line ratio (mean):       ${ratioMean?.toFixed(4)}`)
console.log(`  F5/FG ratio std dev:           ${ratioStd?.toFixed(4)}   <- spread around heuristic`)
console.log(`  Median bid-ask spread:         ${spreadMedian?.toFixed(1)}¢   <- round-trip cost per contract`)
console.log(`  Avg ask depth at best price:   ${avgAskSize?.toFixed(0)} contracts  <- liquidity per fill`)
console.log(`  Typical alt lines per game:    ${altLineMed}   <- line options per game`)
console.log(`  F5 line range:                 [${[...allStrikes].sort((a,b)=>a-b).join(', ')}]`)
console.log(`  Games with F5 mkts today:      ${f5Games.length}`)
console.log('='.repeat(70))
