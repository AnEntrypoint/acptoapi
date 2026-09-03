'use strict';

// Single source of truth for splitting a "<brand>/<model>" string into its
// prefix and rest -- previously duplicated independently in server.js and
// passthrough.js (AGENTS.md documented this as a "keep in sync manually"
// wart; consolidated here instead). Distinct from lib/sdk.js's splitPrefix,
// which resolves acptoapi's own provider registry, not raw brand-model ids.

function normalizeModelId(model) {
  if (typeof model !== 'string') return model;
  // Preserve dotted GLM version IDs when upstream/client rewrites dots to dashes.
  if (model === 'z-ai/glm-5-1') return 'z-ai/glm-5.1';
  if (model === 'glm-5-1') return 'glm-5.1';
  return model;
}

function splitBrandModel(fullModel, { normalize = false } = {}) {
  const m = /^([a-z0-9-]+)\/(.+)$/.exec(fullModel || '');
  if (!m) return null;
  return { prefix: m[1], model: normalize ? normalizeModelId(m[2]) : m[2] };
}

module.exports = { splitBrandModel, normalizeModelId };
