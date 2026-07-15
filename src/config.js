// Optional codelens.json config file — CLI defaults (days/port/plan/...) and
// pricingOverrides for negotiated rates or self-hosted models the hardcoded
// tables and LiteLLM overlay can't know about.
//
// Precedence: CLI flags > project ./codelens.json > user
// ~/.config/codelens/codelens.json > built-ins. index.js's Commander defaults
// come from loadConfig()'s return value, so an explicit flag (which Commander
// tracks as option-source 'cli') always wins for free.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fillRateDefaults, matchRate, normalizeExternalId } from './pricing.js';

export const DEFAULT_USER_CONFIG_PATH = path.join(os.homedir(), '.config', 'codelens', 'codelens.json');
export const DEFAULT_PROJECT_CONFIG_PATH = path.join(process.cwd(), 'codelens.json');

const KNOWN_KEYS = new Set(['days', 'port', 'plan', 'codexPlan', 'offline', 'pricingOverrides']);

// Module-level: the merged, normalized pricingOverrides map that parsers read
// through getPricingOverride — mirrors pricing.js's own `overlay` singleton, so
// resolveClaudeRates/getCodexPricing need no new parameters threaded through
// their existing call chains.
let overridesMap = null;

function readConfigFile(file) {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Malformed JSON in config file ${file}: ${e.message}`);
  }
}

function warnUnknownKeys(config, file) {
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) {
      console.error(`  Warning: unknown config key "${key}" in ${file} — ignored.`);
    }
  }
}

// Validates and normalizes the merged pricingOverrides object into the same
// per-million { input, output, cacheRead, cacheWrite } shape the LiteLLM
// overlay uses, keyed by normalizeExternalId so lookups match the same way.
function buildOverridesMap(rawOverrides) {
  const map = {};
  for (const [key, rate] of Object.entries(rawOverrides)) {
    if (!rate || !Number.isFinite(rate.input) || !Number.isFinite(rate.output)) {
      console.error(`  Warning: pricingOverrides["${key}"] needs numeric input/output rates — ignored.`);
      continue;
    }
    map[normalizeExternalId(key)] = fillRateDefaults(rate);
  }
  return map;
}

export function loadConfig({ userConfigPath = DEFAULT_USER_CONFIG_PATH, projectConfigPath = DEFAULT_PROJECT_CONFIG_PATH } = {}) {
  const userRaw = readConfigFile(userConfigPath);
  const projectRaw = readConfigFile(projectConfigPath);
  const user = userRaw || {};
  const project = projectRaw || {};
  warnUnknownKeys(user, userConfigPath);
  warnUnknownKeys(project, projectConfigPath);

  const merged = { ...user, ...project };
  // Per-model merge, not wholesale replace: a project config can add/override
  // specific models without repeating the user's org-wide defaults.
  const rawOverrides = { ...(user.pricingOverrides || {}), ...(project.pricingOverrides || {}) };
  const pricingOverrides = buildOverridesMap(rawOverrides);
  overridesMap = pricingOverrides;

  // null (not '') when unconfigured, so cache.js's null-safe comparison never
  // invalidates an existing cache for users who don't use this feature.
  const pricingOverridesHash = Object.keys(rawOverrides).length > 0
    ? createHash('sha1').update(JSON.stringify(rawOverrides)).digest('hex').slice(0, 8)
    : null;

  return {
    days: merged.days,
    port: merged.port,
    plan: merged.plan,
    codexPlan: merged.codexPlan,
    offline: merged.offline,
    pricingOverrides,
    pricingOverridesHash,
    // Which of the two known locations actually had a file, and their paths —
    // index.js logs this so it's obvious at a glance whether a config was
    // picked up at all, and if so, from where.
    configPaths: { user: userConfigPath, project: projectConfigPath },
    loaded: { user: userRaw !== null, project: projectRaw !== null },
  };
}

export function getPricingOverride(modelName) {
  return matchRate(overridesMap, modelName);
}

// ── test seams (mirrors pricing.js's __setOverlayForTest/__resetOverlayForTest) ──
export function __setPricingOverridesForTest(map) { overridesMap = map; }
export function __resetPricingOverridesForTest() { overridesMap = null; }
