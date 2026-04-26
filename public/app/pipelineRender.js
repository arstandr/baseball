// public/app/pipelineRender.js — Shared pipeline step renderers.
// Imported by log.js (accordion) and pipeline.js (detail panel).
// All functions are pure: take data, return HTML strings.

import { fmt$, esc } from './utils.js'

function badge(text, type = 'neutral') {
  return `<span class="sc-pipe-badge sc-pipe-badge-${type}">${esc(String(text))}</span>`
}

function kv(key, val, good = null) {
  const cls = good === true ? 'good' : good === false ? 'bad' : ''
  return `<div class="sc-pipe-kv-row"><span class="sc-pipe-kv-k">${esc(key)}</span><span class="sc-pipe-kv-v ${cls}">${val ?? '—'}</span></div>`
}

function pct(v) { return v != null ? (v * 100).toFixed(1) + '%' : '—' }
function num(v, d = 2) { return v != null ? Number(v).toFixed(d) : '—' }

function stepWrap(num, title, summary, body, hasMissing = false) {
  if (hasMissing) return `<div class="sc-pipe-step sc-pipe-step-missing">
    <div class="sc-pipe-step-head">
      <span class="sc-pipe-step-num">${num}</span>
      <span class="sc-pipe-step-title">${title}</span>
      <span class="sc-pipe-step-summary muted">not recorded</span>
    </div></div>`
  return `<div class="sc-pipe-step">
    <div class="sc-pipe-step-head">
      <span class="sc-pipe-step-num">${num}</span>
      <span class="sc-pipe-step-title">${title}</span>
      <span class="sc-pipe-step-summary">${summary}</span>
    </div>
    <div class="sc-pipe-step-body">${body}</div>
  </div>`
}

export function renderModelInput(j) {
  if (!j) return ''
  return `<div class="sc-pipe-kv">
    ${kv('Career K%', pct(j.k_pct_career))}
    ${kv('K/9 career', num(j.k9_career, 1))}
    ${kv('K/9 L5', num(j.k9_l5, 1))}
    ${kv('Savant K%', pct(j.k_pct_l5))}
    ${kv('Savant whiff%', pct(j.savant_whiff))}
    ${kv('FB velo', j.savant_fbv ? j.savant_fbv.toFixed(1) + ' mph' : '—')}
    ${kv('Velo trend', j.velo_trend_mph != null ? (j.velo_trend_mph >= 0 ? '+' : '') + j.velo_trend_mph.toFixed(1) + ' mph' : '—')}
    ${kv('Expected BF', j.expected_bf ? j.expected_bf.toFixed(1) + ' [' + esc(j.bf_source ?? '') + ']' : '—')}
    ${kv('Opponent', esc(j.opp_team ?? '—'))}
    ${kv('Opp K%', pct(j.opp_k_pct) + (j.opp_kpct_source ? ' [' + esc(j.opp_kpct_source) + ']' : ''))}
    ${kv('Confidence', esc(j.confidence ?? '—'))}
    ${kv('Hand', esc(j.hand ?? '—'))}
    ${kv('Starts', j.n_starts ?? '—')}
  </div>`
}

export function renderLambdaCalc(j) {
  if (!j) return ''
  const steps = []
  steps.push(`<span class="sc-pipe-chain-base">λ base = ${num(j.lambda_base, 2)}</span>`)
  if (j.velo_adj != null && j.velo_adj !== 1.0) steps.push(`× velo ${num(j.velo_adj, 3)}`)
  if (j.bb_penalty != null && j.bb_penalty !== 1.0) steps.push(`× BB% ${num(j.bb_penalty, 3)}`)
  if (j.tto_penalty != null && j.tto_penalty !== 1.0) steps.push(`× TTO ${num(j.tto_penalty, 3)}`)
  if (j.split_adj != null && j.split_adj !== 1.0) steps.push(`× split ${num(j.split_adj, 3)}`)
  if (j.opp_adj != null && j.opp_adj !== 1.0) steps.push(`× opp ${num(j.opp_adj, 3)}`)
  if (j.park_factor != null && j.park_factor !== 1.0) steps.push(`× park ${num(j.park_factor, 3)}`)
  if (j.weather_mult != null && j.weather_mult !== 1.0) steps.push(`× wx ${num(j.weather_mult, 3)}`)
  if (j.ump_factor != null && j.ump_factor !== 1.0) steps.push(`× ump ${num(j.ump_factor, 3)}`)
  steps.push(`<strong>= λ ${num(j.lambda_final, 2)}</strong>`)
  return `<div class="sc-pipe-chain">${steps.map(s => `<span class="sc-pipe-chain-step">${s}</span>`).join('<span class="sc-pipe-chain-arrow">→</span>')}</div>
    <div class="sc-pipe-kv" style="margin-top:8px">
      ${j.tto_note ? kv('TTO note', esc(j.tto_note)) : ''}
      ${kv('Leash flag', j.leash_flag ? '⚠️ Yes' : 'No', j.leash_flag ? false : null)}
      ${j.avg_pitches ? kv('Avg pitches', j.avg_pitches.toFixed(0)) : ''}
      ${j.ump_name ? kv('Umpire', esc(j.ump_name)) : ''}
      ${j.weather_note && j.weather_note !== 'n/a' ? kv('Weather', esc(j.weather_note)) : ''}
    </div>`
}

export function renderEdges(arr) {
  if (!arr?.length) return '<div class="muted">No market data recorded.</div>'
  const rows = arr.map(e => {
    const edgeCls = e.passed ? 'good' : 'bad'
    const edgeVal = e.best_edge != null ? ((e.best_edge * 100).toFixed(1) + '¢') : '—'
    return `<tr class="${e.passed ? 'pipe-edge-passed' : 'pipe-edge-failed'}">
      <td>${e.strike}+</td>
      <td>${pct(e.model_prob)}</td>
      <td>${e.mid != null ? e.mid.toFixed(0) + '¢' : '—'}</td>
      <td>${e.spread != null ? e.spread + '¢' : '—'}</td>
      <td class="${edgeCls}">${edgeVal}</td>
      <td>${e.threshold_cents != null ? e.threshold_cents.toFixed(1) + '¢' : '—'}</td>
      <td>${e.passed ? badge('EDGE', 'good') : badge(e.reason || 'miss', 'bad')}</td>
    </tr>`
  })
  return `<table class="sc-pipe-table">
    <thead><tr><th>Strike</th><th>Model</th><th>Mid</th><th>Spread</th><th>Edge</th><th>Threshold</th><th>Decision</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>`
}

export function renderRuleFilters(j) {
  if (!j) return ''
  const lines = []
  const add = (label, items, type = 'bad') => {
    if (items?.length) lines.push(`<div class="sc-pipe-rule-row">${badge(label, type)} ${items.map(i => `${i.strike}+ ${i.side}`).join(', ')}</div>`)
  }
  add('Yes-cap drop', j.yes_per_pitcher_cap?.dropped)
  add('Rule A drop', j.rule_a_no_ban?.dropped)
  add('Rule D drop', j.rule_d_yes_low_prob?.dropped)
  lines.push(`<div class="sc-pipe-rule-row">${badge('Inputs', 'neutral')} ${j.inputs_count ?? '?'} markets evaluated → ${badge('Passed', 'good')} ${j.passed_count ?? '?'}</div>`)
  return `<div class="sc-pipe-rules">${lines.join('')}</div>`
}

export function renderPreflight(j) {
  if (!j) return ''
  const actionType = j.action === 'proceed' ? 'good' : j.action === 'boost' ? 'good' : 'bad'

  let newsHtml = ''
  if (j.headlines?.length) {
    const skips   = j.headlines.filter(h => h.signal === 'skip')
    const boosts  = j.headlines.filter(h => h.signal === 'boost')
    const neutral = j.headlines.filter(h => h.signal === 'neutral')
    const rows = [
      ...skips.map(h   => `<div class="sc-pipe-news-row sc-pipe-news-skip">${badge('SKIP', 'bad')} <span class="sc-pipe-news-src muted">[${esc(h.source)}]</span> ${esc(h.text)}</div>`),
      ...boosts.map(h  => `<div class="sc-pipe-news-row sc-pipe-news-boost">${badge('BOOST', 'good')} <span class="sc-pipe-news-src muted">[${esc(h.source)}]</span> ${esc(h.text)}</div>`),
      ...neutral.map(h => `<div class="sc-pipe-news-row sc-pipe-news-neutral"><span class="sc-pipe-badge sc-pipe-badge-neutral">—</span> <span class="sc-pipe-news-src muted">[${esc(h.source)}]</span> ${esc(h.text)}</div>`),
    ]
    newsHtml = `<div class="sc-pipe-news" style="margin-top:10px">
      <div class="sc-pipe-news-label muted" style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">News (${j.headlines.length} found)</div>
      ${rows.join('')}
    </div>`
  } else if (j.headlines) {
    newsHtml = `<div class="sc-pipe-news muted" style="margin-top:8px;font-size:11px">No relevant headlines found</div>`
  }

  const summaryHtml = j.summary_text
    ? `<div class="sc-pipe-summary" style="margin:10px 0 4px;padding:8px 10px;background:var(--bg2,#1e1e1e);border-radius:6px;font-size:12px;line-height:1.6;color:var(--text)">${esc(j.summary_text)}</div>`
    : ''

  return `${summaryHtml}<div class="sc-pipe-kv">
    ${kv('Action', badge(j.action ?? '—', actionType))}
    ${kv('Confidence', j.confidence != null ? (j.confidence * 100).toFixed(0) + '%' : '—')}
    ${kv('Reason', `<span class="sc-pipe-reason">${esc(j.reason ?? '—')}</span>`)}
    ${j.dk_line != null ? kv('DK line', j.dk_line + ' Ks (model λ=' + num(j.model_lambda, 2) + ')') : ''}
  </div>${newsHtml}`
}

export function renderBetsPlaced(j) {
  if (!j?.rows?.length) return '<div class="muted">No bets logged.</div>'
  const rows = j.rows.map(r => `<tr>
    <td>${r.strike}+</td>
    <td>${esc(r.side)}</td>
    <td>${r.bet_size != null ? fmt$(r.bet_size) : '—'}</td>
    <td>${r.fill != null ? (r.fill * 100).toFixed(0) + '¢' : '—'}</td>
    <td class="good">${r.edge != null ? (r.edge * 100).toFixed(1) + '¢' : '—'}</td>
    <td class="muted" style="font-size:10px">${r.ticker ? esc(r.ticker.slice(-20)) : '—'}</td>
  </tr>`)
  return `<table class="sc-pipe-table">
    <thead><tr><th>Strike</th><th>Side</th><th>Size</th><th>Fill</th><th>Edge</th><th>Ticker</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
  <div class="sc-pipe-rule-row" style="margin-top:8px">${badge('Total at risk', 'neutral')} ${j.total_risk_usd != null ? fmt$(j.total_risk_usd) : '—'}</div>`
}

export function renderPipelineSteps(data) {
  const mi  = data.model_input_json
  const lc  = data.lambda_calc_json
  const ed  = data.edges_json
  const rf  = data.rule_filters_json
  const pf  = data.preflight_json
  const bp  = data.bets_placed_json

  const lambdaSummary = lc ? `λ = ${num(lc.lambda_final, 2)}` : '—'
  const edgeSummary   = ed ? `${ed.filter(e => e.passed).length} / ${ed.length} markets` : '—'
  const pfSummary     = pf ? (pf.action ?? '—') : '—'
  const bpSummary     = bp ? `${bp.rows?.length ?? 0} bet${bp.rows?.length === 1 ? '' : 's'} · ${bp.total_risk_usd != null ? fmt$(bp.total_risk_usd) : '—'}` : '—'

  return [
    stepWrap(1, 'Model Input',       mi ? `${esc(data.confidence ?? '')}` : '—',    renderModelInput(mi),   !mi),
    stepWrap(2, 'Lambda Calculation', lambdaSummary,                                 renderLambdaCalc(lc),   !lc),
    stepWrap(3, 'Edge Calculation',   edgeSummary,                                   renderEdges(ed),        !ed),
    stepWrap(4, 'Rule Filters',       rf ? `${rf.passed_count ?? '?'} passed` : '—', renderRuleFilters(rf),  !rf),
    stepWrap(5, 'Preflight Check',    pfSummary,                                     renderPreflight(pf),    !pf),
    stepWrap(6, 'Bets Placed',        bpSummary,                                     renderBetsPlaced(bp),   !bp),
  ].join('')
}
