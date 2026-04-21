// agents/storm/index.js — Storm (weather) agent
// See AGENTS.md §Agent 4.

import { fetchGameWeather } from '../../lib/weather.js'
import {
  tempCategory,
  windDirectionRelative,
  windAdjustment,
  precipFlag,
  humidityAdjustment,
  weatherScore,
} from './encoding.js'
import { saveAgentOutput, saveWeather } from '../../lib/db.js'

/**
 * Run Storm for a single game, given park output from the Park agent.
 * Dome venues skip the OpenWeather call entirely.
 */
export async function run(game, park) {
  const dome = park?.roof === 'dome'
  const baseOut = {
    agent: 'storm',
    game_id: game.id,
    venue_id: park?.venue_id || game.venue_id,
    first_pitch_time: game.game_time,
    dome,
    disqualify: false,
    disqualify_reason: null,
    weather_score: 0,
    last_updated: new Date().toISOString(),
  }
  if (dome) {
    const out = {
      ...baseOut,
      temp_f: 72,
      temp_category: 'warm',
      temp_adjustment: 0,
      wind_mph: 0,
      wind_bearing_degrees: null,
      wind_direction_relative: 'none',
      wind_adjustment: 0,
      humidity_pct: 0.5,
      humidity_adjustment: 0,
      precip_probability: 0,
      precip_timing: 'n/a',
      weather_score: 0,
    }
    await persist(game, out)
    return out
  }

  const wx = await fetchGameWeather({
    lat: park?.coordinates?.lat,
    lng: park?.coordinates?.lng,
    gameTime: game.game_time,
  })
  if (!wx.ok) {
    // Per DATA.md §Data Quality Rules: neutral weather on failure, don't block.
    const out = {
      ...baseOut,
      temp_f: null,
      temp_category: null,
      temp_adjustment: 0,
      wind_mph: null,
      wind_bearing_degrees: null,
      wind_direction_relative: 'unknown',
      wind_adjustment: 0,
      humidity_pct: null,
      humidity_adjustment: 0,
      precip_probability: null,
      precip_timing: 'unknown',
      weather_score: 0,
      _failure: wx.error,
    }
    await persist(game, out)
    return out
  }

  const temp = tempCategory(wx.temp_f)
  const relDir = windDirectionRelative(wx.wind_bearing_degrees, park.orientation_degrees)
  const windAdj = windAdjustment(wx.wind_mph, relDir)
  const precip = precipFlag(wx.precip_probability)
  const humAdj = humidityAdjustment(wx.humidity, wx.temp_f)
  const score = weatherScore({
    temp_adjustment: temp.adjustment,
    wind_adjustment: windAdj,
    humidity_adjustment: humAdj,
  })

  const out = {
    ...baseOut,
    temp_f: wx.temp_f,
    temp_category: temp.category,
    temp_adjustment: temp.adjustment,
    wind_mph: wx.wind_mph,
    wind_bearing_degrees: wx.wind_bearing_degrees,
    wind_direction_relative: relDir,
    wind_adjustment: windAdj,
    humidity_pct: wx.humidity,
    humidity_adjustment: humAdj,
    precip_probability: wx.precip_probability,
    precip_timing: precip.timing,
    weather_score: score,
    disqualify: precip.disqualify,
    disqualify_reason: precip.disqualify ? 'precipitation_over_40pct' : null,
  }
  await persist(game, out)
  return out
}

async function persist(game, out) {
  await saveAgentOutput(game.id, 'storm', out)
  await saveWeather({
    game_id: game.id,
    venue_id: out.venue_id,
    first_pitch_time: out.first_pitch_time,
    temp_f: out.temp_f,
    temp_category: out.temp_category,
    wind_mph: out.wind_mph,
    wind_bearing_degrees: out.wind_bearing_degrees,
    wind_direction_relative: out.wind_direction_relative,
    wind_adjustment: out.wind_adjustment,
    humidity: out.humidity_pct,
    precip_probability: out.precip_probability,
    precip_timing: out.precip_timing,
    dome: out.dome ? 1 : 0,
    disqualify: out.disqualify ? 1 : 0,
    weather_score: out.weather_score,
  })
}
