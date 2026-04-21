// scripts/historical/fetchWeather.js — historical weather from Open-Meteo.
//
// Free, no key, goes back to 2000. For each game (venue + game_time) we pull
// hourly wx at the venue coordinates and select the hour matching first pitch.
//
//   GET https://archive.api.open-meteo.com/v1/archive
//       ?latitude=...&longitude=...&start_date=...&end_date=...
//       &hourly=temperature_2m,windspeed_10m,winddirection_10m,precipitation_probability,relativehumidity_2m

import axios from 'axios'
import { getCached, sleep } from './cache.js'

const BASE = 'https://historical-forecast-api.open-meteo.com/v1/forecast'
const THROTTLE_MS = 200

export async function fetchGameWeather({ lat, lng, date, gameTime }) {
  if (lat == null || lng == null || !date) return null
  const cacheKey = `${lat.toFixed(3)}_${lng.toFixed(3)}_${date}`
  const data = await getCached('weather', cacheKey, async () => {
    try {
      const res = await axios.get(BASE, {
        params: {
          latitude: lat,
          longitude: lng,
          start_date: date,
          end_date: date,
          hourly:
            'temperature_2m,windspeed_10m,winddirection_10m,precipitation_probability,relativehumidity_2m,precipitation',
          temperature_unit: 'fahrenheit',
          windspeed_unit: 'mph',
          timezone: 'UTC',
        },
        timeout: 15000,
        validateStatus: s => s >= 200 && s < 500,
      })
      if (res.status >= 400) return null
      return res.data
    } catch {
      return null
    }
  })
  if (!data?.hourly?.time?.length) return null

  // Find the hour closest to game_time
  const target = gameTime ? new Date(gameTime).getTime() : new Date(`${date}T19:05:00Z`).getTime()
  let bestIdx = 0
  let bestDelta = Infinity
  for (let i = 0; i < data.hourly.time.length; i++) {
    const t = new Date(`${data.hourly.time[i]}:00Z`).getTime()
    const delta = Math.abs(t - target)
    if (delta < bestDelta) {
      bestDelta = delta
      bestIdx = i
    }
  }

  return {
    temp_f: data.hourly.temperature_2m?.[bestIdx] ?? null,
    wind_mph: data.hourly.windspeed_10m?.[bestIdx] ?? null,
    wind_bearing_degrees: data.hourly.winddirection_10m?.[bestIdx] ?? null,
    precipitation: data.hourly.precipitation?.[bestIdx] ?? null,
    precip_probability:
      data.hourly.precipitation_probability?.[bestIdx] != null
        ? Number(data.hourly.precipitation_probability[bestIdx]) / 100
        : null,
    humidity_pct:
      data.hourly.relativehumidity_2m?.[bestIdx] != null
        ? Number(data.hourly.relativehumidity_2m[bestIdx]) / 100
        : null,
    hour_used: data.hourly.time[bestIdx],
  }
}

/**
 * Convenience: emit weather for every game in a season. Caller stores.
 */
export async function ingestSeason(season, venueLookup) {
  const db = await import('../../lib/db.js')
  const games = await db.all(
    `SELECT id, date, game_time, venue_id FROM historical_games WHERE season = ?`,
    [season],
  )
  let done = 0, matched = 0
  for (const g of games) {
    const v = venueLookup(g.venue_id)
    if (!v || v.lat == null || v.lng == null) { done++; continue }
    await fetchGameWeather({
      lat: v.lat,
      lng: v.lng,
      date: g.date,
      gameTime: g.game_time,
    })
    matched++
    done++
    if (done % 250 === 0) {
      process.stderr.write(
        `[weather] season ${season}: ${done}/${games.length} matched=${matched}\n`,
      )
    }
    await sleep(THROTTLE_MS)
  }
  return { season, processed: done, matched }
}
