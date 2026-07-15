// External pricing overlay — auto-prices models the hardcoded tables don't
// know, so a new model id doesn't need a manual code edit to be costed.
//
// Source: LiteLLM's public price map (2900+ models, updated continuously). We
// fetch it on demand, cache it to disk with a TTL, and fall back to the cache
// (then to nothing) when offline or the fetch fails. The hardcoded tables in
// claude-parser/codex-parser stay AUTHORITATIVE — this overlay is consulted
// only for models they don't match, so our date-tiered / long-context /
// 1h-cache precision is never overridden. Rates are normalized to the
// per-MILLION-token shape both parsers use: { input, output, cacheRead, cacheWrite }.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'agent-analytics');
const PRICING_CACHE_FILE = path.join(CACHE_DIR, 'pricing.json');
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // refetch at most once a day
const PER_MIL = 1_000_000;

// Module-level overlay: normalized model id -> { input, output, cacheRead, cacheWrite }.
// null until loadPricingOverlay runs; lookupExternalRate is a no-op until then.
let overlay = null;
let overlaySource = null; // 'network' | 'cache' | 'disabled' | null (for reporting)

// Strip our billing markers ([fast]/[us]/[long]) and a provider prefix, lowercase.
export function normalizeExternalId(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/^(anthropic|openai|azure|vertex_ai|bedrock)\//, '')
    .trim();
}

// cache_read is common; cache_creation is Anthropic-specific. Fall back to the
// usual ratios (read ≈ 0.1× input, 5-min write ≈ 1.25× input) when a rate omits
// them, so cost never silently drops cache spend. Shared by the LiteLLM overlay
// below and by config.js's pricingOverrides normalization.
export function fillRateDefaults({ input, output, cacheRead, cacheWrite }) {
  return {
    input,
    output,
    cacheRead: Number.isFinite(cacheRead) ? cacheRead : input * 0.1,
    cacheWrite: Number.isFinite(cacheWrite) ? cacheWrite : input * 1.25,
  };
}

// Build the {input,output,cacheRead,cacheWrite} per-million map from LiteLLM's
// per-token JSON. Only entries that expose an input+output token price are kept
// (skips embeddings, image models, and rerankers with no chat token pricing).
function buildOverlay(litellm) {
  const map = {};
  for (const [key, e] of Object.entries(litellm || {})) {
    if (!e || typeof e !== 'object') continue;
    const input = e.input_cost_per_token;
    const output = e.output_cost_per_token;
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    const rate = fillRateDefaults({ input, output, cacheRead: e.cache_read_input_token_cost, cacheWrite: e.cache_creation_input_token_cost });
    map[normalizeExternalId(key)] = {
      input: rate.input * PER_MIL,
      output: rate.output * PER_MIL,
      cacheRead: rate.cacheRead * PER_MIL,
      cacheWrite: rate.cacheWrite * PER_MIL,
    };
  }
  return map;
}

// Look up a model's rate in a normalized-id -> rate map. Tries exact match,
// then a date-suffix-stripped match (claude-opus-9-20270101 → claude-opus-9),
// then the longest map key the id starts with (mirrors the hardcoded substring
// approach). Shared by the LiteLLM overlay and config.js's pricingOverrides.
export function matchRate(map, modelName) {
  if (!map) return null;
  const id = normalizeExternalId(modelName);
  if (!id) return null;
  if (map[id]) return map[id];
  const dateless = id.replace(/-\d{8}$/, '');
  if (dateless !== id && map[dateless]) return map[dateless];
  let best = null;
  let bestLen = 0;
  for (const key of Object.keys(map)) {
    if (key.length > bestLen && (id === key || id.startsWith(`${key}-`))) {
      best = map[key];
      bestLen = key.length;
    }
  }
  return best;
}

// Returns per-million { input, output, cacheRead, cacheWrite } or null.
export function lookupExternalRate(modelName) {
  return matchRate(overlay, modelName);
}

export function overlayLoaded() {
  return overlay !== null;
}
export function overlayInfo() {
  return { loaded: overlay !== null, source: overlaySource, models: overlay ? Object.keys(overlay).length : 0 };
}

function readCache(cacheFile) {
  try {
    return JSON.parse(readFileSync(cacheFile, 'utf-8'));
  } catch {
    return null;
  }
}
function writeCache(cacheFile, litellm, now) {
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: now, models: litellm }));
  } catch {
    // Best-effort — a read-only cache dir just means we refetch next run.
  }
}

/**
 * Load the external pricing overlay into module state.
 *   offline  — never hit the network; use the disk cache if present.
 *   refresh  — ignore a fresh cache and refetch (maps to CLI --refresh).
 *   ttlMs    — cache freshness window (default 24h).
 *   fetchImpl/now — injectable for tests.
 * Never throws: on any failure the overlay is left empty (parsers fall back to
 * their hardcoded last-resort pricing, exactly as before this feature).
 */
export async function loadPricingOverlay({ offline = false, refresh = false, ttlMs = DEFAULT_TTL_MS, fetchImpl = fetch, now = Date.now, cacheFile = PRICING_CACHE_FILE } = {}) {
  const cached = readCache(cacheFile);

  if (offline) {
    overlay = cached?.models ? buildOverlay(cached.models) : {};
    overlaySource = cached?.models ? 'cache' : 'disabled';
    return overlayInfo();
  }

  const fresh = cached && Number.isFinite(cached.fetchedAt) && (now() - cached.fetchedAt) < ttlMs;
  if (fresh && !refresh) {
    overlay = buildOverlay(cached.models);
    overlaySource = 'cache';
    return overlayInfo();
  }

  try {
    const res = await fetchImpl(LITELLM_PRICING_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const litellm = await res.json();
    writeCache(cacheFile, litellm, now());
    overlay = buildOverlay(litellm);
    overlaySource = 'network';
  } catch {
    // Network failed — degrade to the cache, then to empty.
    overlay = cached?.models ? buildOverlay(cached.models) : {};
    overlaySource = cached?.models ? 'cache' : 'disabled';
  }
  return overlayInfo();
}

// ── test seams ──
export function __setOverlayForTest(map) { overlay = map; overlaySource = map ? 'test' : null; }
export function __resetOverlayForTest() { overlay = null; overlaySource = null; }
export const __cacheFile = PRICING_CACHE_FILE;
