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
// LiteLLM keys Moonshot models as moonshot/kimi-k2-... (and moonshotai/... for
// open-weight hosts) — stripping the prefix lets a bare session-log model id
// like 'kimi-k2-0905-preview' resolve to that entry.
export function normalizeExternalId(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/^(anthropic|openai|azure|vertex_ai|bedrock|moonshotai|moonshot)\//, '')
    .trim();
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
    // cache_read is common; cache_creation is Anthropic-specific. Fall back to
    // the usual ratios (read ≈ 0.1× input, 5-min write ≈ 1.25× input) when a
    // model omits them, so cost never silently drops cache spend.
    const cacheRead = Number.isFinite(e.cache_read_input_token_cost) ? e.cache_read_input_token_cost : input * 0.1;
    const cacheWrite = Number.isFinite(e.cache_creation_input_token_cost) ? e.cache_creation_input_token_cost : input * 1.25;
    map[normalizeExternalId(key)] = {
      input: input * PER_MIL,
      output: output * PER_MIL,
      cacheRead: cacheRead * PER_MIL,
      cacheWrite: cacheWrite * PER_MIL,
    };
  }
  return map;
}

// Look up a model's rates in the overlay. Tries exact match, then a
// date-suffix-stripped match (claude-opus-9-20270101 → claude-opus-9), then the
// longest overlay key the id starts with (mirrors the hardcoded substring
// approach). Returns per-million { input, output, cacheRead, cacheWrite } or null.
export function lookupExternalRate(modelName) {
  if (!overlay) return null;
  const id = normalizeExternalId(modelName);
  if (!id) return null;
  if (overlay[id]) return overlay[id];
  const dateless = id.replace(/-\d{8}$/, '');
  if (dateless !== id && overlay[dateless]) return overlay[dateless];
  let best = null;
  let bestLen = 0;
  for (const key of Object.keys(overlay)) {
    if (key.length > bestLen && (id === key || id.startsWith(`${key}-`))) {
      best = overlay[key];
      bestLen = key.length;
    }
  }
  return best;
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
