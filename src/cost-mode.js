// --cost-mode calculate|auto|display + --debug pricing reconciliation.
//
// "Calculated" cost = the hardcoded tier tables (claude-parser.js's PRICING,
// codex-parser.js's CODEX_PRICING) — today's default, unchanged in `calculate`
// mode. Neither Claude Code nor Codex session logs persist a real dollar-cost
// value historically (verified against both parsers and their fixtures), so
// there is no literal "Anthropic-reported" figure available to fall back to.
// "Logged" is redefined as the external LiteLLM overlay rate
// (pricing.js:lookupExternalRate) — the closest independent rate source that
// actually exists for historical sessions.
//
// The parsers compute and cache `overlayCost` per model (session-level in
// modelBreakdown, day-level in dailyUsage[date].byModel) plus aggregate
// overlayTotalCost/costModeIncomplete on session.cost and each dailyUsage[date]
// entry — this module only selects which number wins per mode, applied fresh
// on every run so switching modes never requires a re-parse.

export const COST_MODES = ['calculate', 'auto', 'display'];

export function validateCostMode(value) {
  if (COST_MODES.includes(value)) return null;
  return `Unknown --cost-mode "${value}". Use ${COST_MODES.join(', ')}.`;
}

// auto: overlay rate per model where available, silently falling back to the
// calculated cost for any model the overlay doesn't cover.
function blendedAutoTotal(byModel) {
  let total = 0;
  for (const mb of Object.values(byModel || {})) {
    total += mb.overlayCost != null ? mb.overlayCost : mb.cost;
  }
  return total;
}

// display: pure overlay total, but only when every model in the bucket has
// overlay data — incomplete coverage is surfaced via costModeIncomplete
// instead of being silently blended with calculated numbers (that's auto's job).
function selectTotal(calculateValue, byModel, bucket, mode) {
  if (mode === 'auto') return blendedAutoTotal(byModel);
  if (!bucket.costModeIncomplete && bucket.overlayTotalCost != null) return bucket.overlayTotalCost;
  return calculateValue;
}

// Mutates session.cost.totalCost and each session.dailyUsage[date].cost in
// place to the mode-selected number. calculate is a no-op passthrough.
export function applyCostMode(session, mode) {
  if (mode === 'calculate' || !session?.cost) return;
  session.cost.totalCost = selectTotal(session.cost.totalCost, session.modelBreakdown, session.cost, mode);
  for (const day of Object.values(session.dailyUsage || {})) {
    day.cost = selectTotal(day.cost, day.byModel, day, mode);
  }
}

const DIVERGENCE_FLAG_PCT = 5;

// --debug: per-model reconciliation across all sessions — hardcoded-table
// total vs overlay total, flagging >5% divergence. Skips models the overlay
// has no rate for (nothing independent to compare against). Read from
// modelBreakdown before or after applyCostMode — applyCostMode never mutates
// modelBreakdown, only the aggregate totalCost/cost fields.
export function reconcilePricing(sessions) {
  const hardcoded = {};
  const overlay = {};
  for (const session of sessions || []) {
    for (const [model, mb] of Object.entries(session.modelBreakdown || {})) {
      if (mb.overlayCost == null) continue;
      hardcoded[model] = (hardcoded[model] || 0) + mb.cost;
      overlay[model] = (overlay[model] || 0) + mb.overlayCost;
    }
  }
  const rows = Object.keys(hardcoded).map(model => {
    const calculatedTotal = hardcoded[model];
    const overlayTotal = overlay[model];
    const pctDivergence = overlayTotal > 0 ? ((calculatedTotal - overlayTotal) / overlayTotal) * 100 : 0;
    return { model, calculatedTotal, overlayTotal, pctDivergence, flagged: Math.abs(pctDivergence) > DIVERGENCE_FLAG_PCT };
  });
  rows.sort((a, b) => Math.abs(b.pctDivergence) - Math.abs(a.pctDivergence));
  return rows;
}
