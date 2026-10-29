// Shared .http parser used by scripts/run-http.mjs and scripts/capture.mjs.
export const DEFAULTS = {
  baseUrl: process.env.BASE_URL ?? 'http://localhost:4010',
  tenantId: 'ten_acme',
  tenantGlobex: 'ten_globex',
  token: 'tok_acme_admin',
  tokenSupport: 'tok_acme_support',
  tokenGlobex: 'tok_globex_admin',
  tokenPlatform: 'tok_platform',
};

export function parseFile(text, extra = {}) {
  const variables = { ...DEFAULTS, ...extra };
  for (const line of text.split(/\r?\n/)) {
    const match = /^@([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line.trim());
    if (match) variables[match[1]] = match[2].trim();
  }

  // Variable declarations are file-scoped metadata, not requests.
  const withoutDeclarations = text
    .split(/\r?\n/)
    .filter((line) => !/^@[A-Za-z0-9_]+\s*=/.test(line.trim()))
    .join('\n');

  const blocks = withoutDeclarations
    .split(/^###.*$/m)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      let name = '';
      const forms = [];
      const captures = [];
      let waitMs = 0;
      while (lines.length > 0 && (lines[0].startsWith('#') || lines[0].trim() === '')) {
        const line = lines.shift().trim();
        const named = /^#\s*@name\s+(.+)$/.exec(line);
        if (named) name = named[1].trim();
        const form = /^#\s*@form\s+(.+)$/.exec(line);
        if (form) forms.push(form[1].trim());
        const capture = /^#\s*@capture\s+([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
        if (capture) captures.push({ source: 'body', name: capture[1], path: capture[2].trim() });
        const captureHeader = /^#\s*@captureHeader\s+([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
        if (captureHeader) captures.push({ source: 'header', name: captureHeader[1], path: captureHeader[2].trim() });
        const wait = /^#\s*@wait\s+(\d+)$/.exec(line);
        if (wait) waitMs = Number(wait[1]);
      }
      const requestLine = lines.shift()?.trim();
      if (!requestLine) return null;
      const [method, url] = requestLine.split(/\s+/);
      const headers = {};
      while (lines.length > 0 && lines[0].trim() !== '') {
        const line = lines.shift();
        if (!line || line.trim().startsWith('#')) continue;
        const index = line.indexOf(':');
        if (index === -1) continue;
        headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
      }
      return {
        name,
        method: method.toUpperCase(),
        url,
        headers,
        body: lines.join('\n').trim(),
        forms,
        captures,
        waitMs,
      };
    })
    .filter(Boolean);

  return { variables, blocks };
}

export function substitute(value, variables) {
  return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (whole, name) =>
    name in variables ? variables[name] : whole,
  );
}

export function resolveBlock(block, variables) {
  return {
    ...block,
    url: substitute(block.url, variables),
    headers: Object.fromEntries(
      Object.entries(block.headers).map(([key, value]) => [key, substitute(value, variables)]),
    ),
    body: substitute(block.body, variables),
  };
}

export function applyCaptures(captures, body, variables, getHeader = () => undefined) {
  if (captures.length === 0) return;
  let parsed;
  const bodyCaptures = captures.filter((capture) => capture.source === 'body');
  if (bodyCaptures.length > 0) {
    try {
      parsed = JSON.parse(body);
    } catch {
      console.warn('  ! cannot capture from a non-JSON body');
    }
  }

  for (const capture of captures) {
    if (capture.source === 'header') {
      const value = getHeader(capture.path);
      if (!value) {
        console.warn(`  ! capture ${capture.name}: header ${capture.path} not found`);
        continue;
      }
      variables[capture.name] = value;
      continue;
    }
    const path = capture.path.replace(/^\$\.?/, '').split('.').filter(Boolean);
    let value = parsed;
    for (const part of path) {
      value = value?.[part];
    }
    if (value === undefined || value === null) {
      console.warn(`  ! capture ${capture.name} not found at ${capture.path}`);
      continue;
    }
    variables[capture.name] = String(value);
  }
}
