// agents/storm/encoding.js — weather feature encoding
// See AGENTS.md §Agent 4 for exact thresholds.

export function tempCategory(temp_f) {
  if (temp_f >= 80) return { category: 'hot', adjustment: 0.0 }
  if (temp_f >= 65) return { category: 'warm', adjustment: 0.0 }
  if (temp_f >= 50) return { category: 'cool', adjustment: -0.2 }
  return { category: 'cold', adjustment: -0.4 }
}

/**
 * Compute wind direction RELATIVE to the park's outfield.
 *
 *   relative_angle = wind_bearing - park_orientation
 *
 * park_orientation is the compass direction from home plate to center field.
 * If wind is blowing FROM park_orientation it's blowing IN from CF.
 * If wind is blowing TO park_orientation (i.e. bearing ~ park_orientation)
 * it's blowing OUT to CF.
 *
 * OpenWeather's wind_deg gives the bearing the wind is COMING FROM. So if
 * wind_deg === park_orientation the wind is blowing in from CF. We flip the
 * convention so "out to CF" = 0 degrees relative angle (wind blowing toward CF).
 *
 *   out_bearing     = (park_orientation + 180) mod 360
 *   relative_angle  = (wind_deg - out_bearing + 360) mod 360
 *
 *   0-45 or 315-360 -> "out"  (wind blowing toward CF)
 *   135-225         -> "in"   (wind blowing from CF toward home plate)
 *   otherwise       -> "crosswind"
 */
export function windDirectionRelative(wind_bearing_degrees, park_orientation_degrees) {
  if (wind_bearing_degrees == null || park_orientation_degrees == null) return 'unknown'
  const outBearing = ((park_orientation_degrees + 180) % 360 + 360) % 360
  const rel = ((wind_bearing_degrees - outBearing) % 360 + 360) % 360
  if (rel <= 45 || rel >= 315) return 'out'
  if (rel >= 135 && rel <= 225) return 'in'
  return 'crosswind'
}

/**
 * Wind adjustment (in runs) given speed and direction:
 *   out  + >10mph: +0.4 to +0.8 (linear scale from 10mph to 30mph)
 *   in   + >10mph: -0.3 to -0.6
 *   crosswind: +/- 0.1
 *   <10mph: ~0.0
 */
export function windAdjustment(wind_mph, direction) {
  if (wind_mph == null) return 0
  if (wind_mph < 10) return 0
  const intensity = Math.min(1, (wind_mph - 10) / 20) // 0 at 10mph, 1 at 30mph
  if (direction === 'out') return Number((0.4 + intensity * 0.4).toFixed(3))
  if (direction === 'in') return Number((-0.3 - intensity * 0.3).toFixed(3))
  if (direction === 'crosswind') {
    // Slight over-bias from crosswind — ball carry disrupts defensive routes
    return 0.1
  }
  return 0
}

/**
 * Precipitation logic: flag for "monitor" at 20-40%, disqualify >40%
 * if timing overlaps first-pitch window (we approximate overlap as "same
 * 3-hour forecast block").
 */
export function precipFlag(pop /* 0-1 */) {
  if (pop == null) return { flag: 'unknown', disqualify: false, timing: null }
  if (pop < 0.2) return { flag: 'clear', disqualify: false, timing: 'after_game' }
  if (pop <= 0.4) return { flag: 'monitor', disqualify: false, timing: 'possible' }
  return { flag: 'rain', disqualify: true, timing: 'during_game' }
}

/**
 * Humidity adjustment — minor effect at extremes.
 * >80% humidity + warm/hot: +0.1 (denser air reduces carry slightly but
 * in practice high humidity tends to pair with higher scoring outcomes
 * because ball carries are unaffected at these temps; we use the +0.1
 * convention from the spec).
 */
export function humidityAdjustment(humidity, temp_f) {
  if (humidity == null || temp_f == null) return 0
  if (humidity > 0.8 && temp_f >= 70) return 0.1
  return 0
}

/**
 * Compose the full weather_score: temp_adjustment + wind_adjustment +
 * humidity_adjustment, clamped to [-1.0, +1.0] runs.
 */
export function weatherScore({ temp_adjustment, wind_adjustment, humidity_adjustment }) {
  const raw = (temp_adjustment || 0) + (wind_adjustment || 0) + (humidity_adjustment || 0)
  return Math.max(-1, Math.min(1, Number(raw.toFixed(3))))
}
