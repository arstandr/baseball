// lib/weather.js — NWS (National Weather Service) forecast fetcher.
//
// No API key required. Two-step flow:
//   1. GET https://api.weather.gov/points/{lat},{lng} → forecastHourly URL
//   2. GET forecastHourly → hourly periods, pick the one closest to game time
//
// Returns the same shape as the old OpenWeather implementation so callers
// (strikeoutEdge.js computeWeatherMult) need no changes.

import { fetch } from './http.js'

const NWS_BASE = 'https://api.weather.gov'

/**
 * Parse NWS wind speed string into mph.
 * NWS formats: "10 mph", "5 to 15 mph", "Calm"
 */
function parseWindMph(str) {
  if (!str || /calm/i.test(str)) return 0
  const nums = str.match(/\d+/g)
  if (!nums) return 0
  if (nums.length === 1) return Number(nums[0])
  // "5 to 15 mph" → average
  return (Number(nums[0]) + Number(nums[1])) / 2
}

/**
 * Fetch NWS hourly forecast and return the period covering first pitch.
 *
 * @param {object} args
 * @param {number} args.lat
 * @param {number} args.lng
 * @param {string} args.gameTime - ISO timestamp (local or UTC)
 */
export async function fetchGameWeather({ lat, lng, gameTime }) {
  // Step 1: resolve grid point
  const pointsRes = await fetch('nws.points', {
    method: 'GET',
    url: `${NWS_BASE}/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
    headers: { 'User-Agent': 'MLBIE/1.0 (baseball-model)' },
    timeout: 8000,
  })
  if (!pointsRes.ok) return { ok: false, error: pointsRes.error || 'nws_points_failed' }

  const hourlyUrl = pointsRes.data?.properties?.forecastHourly
  if (!hourlyUrl) return { ok: false, error: 'no_hourly_url' }

  // Step 2: fetch hourly forecast
  const fcRes = await fetch('nws.hourly', {
    method: 'GET',
    url: hourlyUrl,
    headers: { 'User-Agent': 'MLBIE/1.0 (baseball-model)' },
    timeout: 10000,
  })
  if (!fcRes.ok) return { ok: false, error: fcRes.error || 'nws_hourly_failed' }

  const periods = fcRes.data?.properties?.periods
  if (!periods?.length) return { ok: false, error: 'empty_forecast' }

  // Pick the period whose startTime is closest to game time
  const target = new Date(gameTime).getTime()
  let best = periods[0]
  let bestDelta = Math.abs(new Date(best.startTime).getTime() - target)
  for (const p of periods) {
    const delta = Math.abs(new Date(p.startTime).getTime() - target)
    if (delta < bestDelta) { bestDelta = delta; best = p }
  }

  const temp_f    = best.temperatureUnit === 'F' ? best.temperature
                  : best.temperature * 9 / 5 + 32
  const wind_mph  = parseWindMph(best.windSpeed)
  const humidity  = (best.relativeHumidity?.value ?? 50) / 100

  return {
    ok: true,
    temp_f,
    feels_like_f: temp_f,
    humidity,
    pressure: null,
    wind_mph,
    wind_bearing_degrees: null,
    wind_gust_mph: null,
    clouds_pct: null,
    precip_probability: best.probabilityOfPrecipitation?.value != null
      ? best.probabilityOfPrecipitation.value / 100
      : null,
    conditions: best.shortForecast,
    description: best.detailedForecast || best.shortForecast,
    forecast_time: best.startTime,
    raw: best,
  }
}
