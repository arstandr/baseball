// agents/park/index.js — Park agent
// Static venue data. No AI layer. See AGENTS.md §Agent 3.

import { VENUES, resolveVenue } from './venues.js'
import { saveVenue, saveAgentOutput } from '../../lib/db.js'

/**
 * Seed the venues table with the static data from venues.js. Run once on
 * initial migrate; safe to re-run (upsert by id).
 */
export async function seedVenues() {
  for (const v of VENUES) {
    await saveVenue({
      id: v.id,
      name: v.name,
      team: v.team,
      city: v.city,
      lat: v.lat,
      lng: v.lng,
      altitude_feet: v.altitude_feet,
      orientation_degrees: v.orientation_degrees,
      roof_type: v.roof_type,
      surface: v.surface,
      lf_line_feet: v.lf_line_feet,
      rf_line_feet: v.rf_line_feet,
      cf_feet: v.cf_feet,
      run_factor: v.run_factor,
      hr_factor: v.hr_factor,
      f5_factor: v.f5_factor,
    })
  }
  return { seeded: VENUES.length }
}

/**
 * Run the Park agent for a single game. Returns the shape described in
 * AGENTS.md §Agent 3 — Output Schema.
 */
export async function run(game) {
  const venue = resolveVenue({
    id: game.venue_id,
    team: game.team_home,
    name: game.venue_name,
  })
  if (!venue) {
    const fallback = {
      agent: 'park',
      venue_id: game.venue_id,
      venue_name: game.venue_name || 'unknown',
      run_factor: 1.0,
      hr_factor: 1.0,
      f5_factor: 1.0,
      altitude_feet: 0,
      roof: 'open',
      surface: 'grass',
      orientation_degrees: 0,
      coordinates: { lat: null, lng: null },
      _fallback: true,
    }
    await saveAgentOutput(game.id, 'park', fallback)
    return fallback
  }
  const out = {
    agent: 'park',
    venue_id: venue.id,
    venue_name: venue.name,
    team: venue.team,
    run_factor: venue.run_factor,
    hr_factor: venue.hr_factor,
    f5_factor: venue.f5_factor,
    altitude_feet: venue.altitude_feet,
    roof: venue.roof_type,
    surface: venue.surface,
    dimensions: {
      lf: venue.lf_line_feet,
      rf: venue.rf_line_feet,
      cf: venue.cf_feet,
    },
    orientation_degrees: venue.orientation_degrees,
    coordinates: { lat: venue.lat, lng: venue.lng },
  }
  await saveAgentOutput(game.id, 'park', out)
  return out
}
