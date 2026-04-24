const fs = require('fs');
const path = require('path');
const os = require('os');

function interpolateEnv(val) {
  if (typeof val === 'string') return val.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (_, a, b) => process.env[a || b] || '');
  if (Array.isArray(val)) return val.map(interpolateEnv);
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = interpolateEnv(v);
    return out;
  }
  return val;
}

function loadConfig(configPath) {
  const fp = configPath || process.env.THEBIRD_CONFIG || path.join(os.homedir(), '.thebird', 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return interpolateEnv(raw);
  } catch { return {}; }
}

module.exports = { loadConfig, interpolateEnv };
