export const state = {
  view:               localStorage.getItem('ks.view') || 'today',
  selectedDate:       null,
  charts:             { bankroll: null, daily: null, weekly: null },
  log:                { page: 1, pitcher: '', side: '', result: '', from: '', to: '', sort: 'bet_date', dir: 'desc' },
  lastRefresh:        null,
  currentUser:        null,
  currentUserId:      null,
  liveBettorId:       null,
  liveBettorTodayPnl: null,
  liveTimer:          null,
  countdownTimer:     null,
}

// Mutable live data — object properties so any module can write to them
export const shared = {
  liveOverlay:      {},   // pitcher_id → { ks, still_in, is_final, ip, pitches, inning, home_score, away_score }
  dailyPitchers:    [],   // from /api/ks/daily
  liveBetsPitchers: [],   // from /api/ks/live-bets
  betSchedule:      [],   // from /api/ks/schedule — pending T-2.5h entries
  dayPnl:           0,
  bettors:          [],   // from /api/ks/bettors — all active live bettors
}
