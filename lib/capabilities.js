const DEFAULTS = {
  streaming: true,
  toolUse: true,
  vision: true,
  systemMessage: true,
  jsonMode: false
};

// Internal tools that must never be exposed to external callers via acptoapi.
// These are plugkit/rs-exec internals — stripping them maps acptoapi to incoming
// call requirements without leaking filesystem or execution primitives.
const STRIPPED_TOOLS = new Set([
  'fs_read', 'fs_write', 'fs_readdir', 'fs_stat',
  'bash', 'python', 'ssh', 'powershell', 'ps1', 'sh', 'zsh',
  'exec_js', 'nodejs', 'javascript', 'node', 'js',
  'kill-port', 'runner', 'type', 'browser', 'browser_spawn', 'browser_eval', 'browser_close',
  'recall', 'memorize', 'codesearch',
  'feedback', 'learn-status', 'learn-debug', 'learn-build',
  'discipline', 'pause', 'health', 'status', 'wait', 'sleep', 'close', 'forget',
  'kv_get', 'kv_put', 'kv_query',
  'env_get', 'fetch',
]);

function getCapabilities(provider) {
  return { ...DEFAULTS, ...(provider.capabilities || {}) };
}

function stripImageBlocks(messages) {
  return messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const filtered = msg.content.filter(b => b.type !== 'image' && b.type !== 'image_url');
    if (filtered.length === 0) return { ...msg, content: [{ type: 'text', text: '[image removed - unsupported by provider]' }] };
    return { ...msg, content: filtered };
  });
}

function prependSystemAsUser(messages, system) {
  if (!system) return { messages, system: undefined };
  const text = Array.isArray(system) ? system.map(b => b.text || '').join('\n') : system;
  const sysMsg = { role: 'user', content: [{ type: 'text', text }] };
  return { messages: [sysMsg, ...messages], system: undefined };
}

function stripInternalTools(tools) {
  if (!tools || !Array.isArray(tools)) return { tools, stripped: [] };
  const kept = [];
  const stripped = [];
  for (const tool of tools) {
    const name = typeof tool === 'string' ? tool : (tool.function?.name || tool.name || '');
    if (STRIPPED_TOOLS.has(name)) {
      stripped.push(name);
    } else {
      kept.push(tool);
    }
  }
  return { tools: kept.length > 0 ? kept : undefined, stripped };
}

function stripUnsupported(params, caps) {
  const warnings = [];
  const result = { ...params };

  // Always strip internal tools regardless of provider capabilities
  const { tools: cleanedTools, stripped } = stripInternalTools(result.tools);
  if (stripped.length > 0) {
    warnings.push(`internal tools stripped: ${stripped.join(', ')}`);
  }
  result.tools = cleanedTools;
  if (!result.tools) delete result.tool_choice;

  if (!caps.toolUse && result.tools) {
    delete result.tools;
    delete result.tool_choice;
    warnings.push('toolUse not supported — tools removed');
  }
  if (!caps.vision && result.messages) {
    result.messages = stripImageBlocks(result.messages);
    warnings.push('vision not supported — image blocks removed');
  }
  if (!caps.systemMessage && result.system) {
    const { messages, system } = prependSystemAsUser(result.messages || [], result.system);
    result.messages = messages;
    result.system = system;
    warnings.push('systemMessage not supported — prepended as user message');
  }
  return { params: result, warnings };
}

module.exports = { getCapabilities, stripUnsupported, stripInternalTools, STRIPPED_TOOLS, DEFAULTS };
