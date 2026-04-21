// lib/weather.js — OpenWeather API
//
// Free tier: 1,000 calls/day — more than enough for ~15 games × 4 updates.
// We pull the 5-day / 3-hour forecast and select the block covering first pitch.

import { fetch } from './http.js'
import 'dotenv/config'

const BASE = 'https://api.openweathermap.org/data/2.5'

/**
 * Fetch forecast and return the 3-hour block covering first pitch.
 *
 * @param {object} args
 * @param {number} args.lat
 * @param {number} args.lng
 * @param {string} args.gameTime - ISO timestamp
 */
export async function fetchGameWeather({ lat, lng, gameTime }) {
  const key = process.env.OPENWEATHER_API_KEY
  if (!key) {
    return { ok: false, error: 'missing_api_key' }
  }
  const res = await fetch('openweather.forecast', {
    method: 'GET',
    url: `${BASE}/forecast`,
    params: {
      lat,
      lon: lng,
      appid: key,
      units: 'imperial',
    },
  })
  if (!res.ok) return { ok: false, error: res.error || res.reason }
  const target = new Date(gameTime).getTime()
  // Pick the forecast entry closest to game time
  const list = res.data?.list || []
  if (!list.length) return { ok: false, error: 'empty_forecast' }
  let best = list[0]
  let bestDelta = Math.abs(new Date(best.dt_txt).getTime() - target)
  for (const entry of list) {
    const delta = Math.abs(entry.dt * 1000 - target)
    if (delta < bestDelta) {
      bestDelta = delta
      best = entry
    }
  }
  return {
    ok: true,
    temp_f: best.main?.temp,
    feels_like_f: best.main?.feels_like,
    humidity: (best.main?.humidity ?? 0) / 100,
    pressure: best.main?.pressure,
    wind_mph: best.wind?.speed,
    wind_bearing_degrees: best.wind?.deg,
    wind_gust_mph: best.wind?.gust,
    clouds_pct: (best.clouds?.all ?? 0) / 100,
    precip_probability: best.pop ?? 0,
    conditions: best.weather?.[0]?.main,
    description: best.weather?.[0]?.description,
    forecast_time: best.dt_txt,
    raw: best,
  }
}
