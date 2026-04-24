const DEFAULTS = {
  streaming: true,
  toolUse: true,
  vision: true,
  systemMessage: true,
  jsonMode: false
};

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

function stripUnsupported(params, caps) {
  const warnings = [];
  const result = { ...params };
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

module.exports = { getCapabilities, stripUnsupported, DEFAULTS };
