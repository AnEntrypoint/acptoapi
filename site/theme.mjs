// AnEntrypoint design-system theme for flatspace.
// Renders site chrome via anentrypoint-design SDK using REAL SDK components.
// theme.mjs emits HTML shell + bootstrap that consumes YAML baked into <script id="__site__">.
// The SDK provides ALL styling via installStyles(); no local <style> block — that ensures
// every portfolio site looks uniform.

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const escapeJson = (obj) => JSON.stringify(obj)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(new RegExp('\\u2028','g'), '\\u2028').replace(new RegExp('\\u2029','g'), '\\u2029');

const SDK_URL = 'https://unpkg.com/anentrypoint-design@latest/dist/247420.js';

const clientScript = `
import { h, applyDiff, installStyles, components as C } from 'anentrypoint-design';
installStyles();
document.documentElement.classList.add('ds-247420');

const data = JSON.parse(document.getElementById('__site__').textContent);
const { site, nav, home } = data;

function Hero() {
  if (!home || !home.hero) return null;
  return C.Panel({
    style: 'margin:8px',
    children: h('div', { style: 'padding:24px 22px' },
      C.Heading({ level: 1, style: 'margin:0 0 8px 0', children: home.hero.heading || site.title }),
      home.hero.subheading ? C.Lede({ children: home.hero.subheading }) : null,
      home.hero.body ? h('p', { style: 'margin:8px 0 16px 0;color:var(--panel-text-2);max-width:64ch' }, home.hero.body) : null,
      (home.hero.badges && home.hero.badges.length) ? h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px 0' },
        ...home.hero.badges.map((b, i) => C.Chip({ key: 'b'+i, children: b.label }))
      ) : null,
      (home.hero.ctas && home.hero.ctas.length) ? h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
        ...home.hero.ctas.map((c, i) => C.Btn({ key: 'c'+i, href: c.href, primary: c.primary, children: c.label }))
      ) : null
    )
  });
}

function Features() {
  if (!home || !home.features || !home.features.items || !home.features.items.length) return null;
  const rows = home.features.items.map((it, i) => C.RowLink({
    key: 'f'+i,
    code: String(i+1).padStart(2,'0'),
    title: it.name,
    sub: it.desc || '',
    meta: it.meta || '',
    href: it.href || '#'
  }));
  return C.Panel({
    title: home.features.heading || 'features',
    style: 'margin:8px',
    children: rows
  });
}

function Quickstart() {
  if (!home || !home.quickstart || !home.quickstart.lines || !home.quickstart.lines.length) return null;
  const lineNodes = home.quickstart.lines.map((l, i) => h('div', { key: 'q'+i, class: 'cli' },
    h('span', { class: 'prompt' }, (l.kind === 'cmt' ? '#' : '

function Examples() {
  if (!home || !home.examples || !home.examples.items || !home.examples.items.length) return null;
  const rows = home.examples.items.map((it, i) => C.RowLink({
    key: 'e'+i,
    title: it.name,
    sub: it.desc || '',
    meta: it.cta || 'open',
    href: it.href || '#'
  }));
  return C.Panel({
    title: home.examples.heading || 'examples',
    style: 'margin:8px',
    children: rows
  });
}

function Footer() {
  return h('footer', { class: 'app-status' },
    h('span', { class: 'item' }, 'styled with '),
    h('a', { class: 'item', href: 'https://anentrypoint.github.io/design/' }, 'anentrypoint-design'),
    h('span', { class: 'item' }, '·'),
    h('a', { class: 'item', href: 'https://247420.xyz' }, '247420.xyz'),
    h('span', { class: 'spread' }),
    site.repo ? h('a', { class: 'item', href: site.repo }, 'source ↗') : null
  );
}

const navItems = (nav && nav.links ? nav.links : []).map(l => [String(l.label || ''), l.href]);

const App = C.AppShell({
  topbar: C.Topbar({
    brand: '247420',
    leaf: site.title || '',
    items: navItems
  }),
  crumb: C.Crumb({
    trail: ['247420'],
    leaf: site.title || ''
  }),
  main: h('div', {},
    Hero(),
    Features(),
    Quickstart(),
    Examples()
  ),
  status: Footer()
});

applyDiff(document.getElementById('app'), [App]);
`;

const html = ({ site, nav, home }) => `<!DOCTYPE html>
<html lang="en" class="ds-247420">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(site.title)}${site.tagline ? ' — ' + escapeHtml(site.tagline) : ''}</title>
  <meta name="description" content="${escapeHtml(site.description || site.tagline || site.title)}" />
  <meta property="og:title" content="${escapeHtml(site.title)}" />
  <meta property="og:description" content="${escapeHtml(site.description || site.tagline || '')}" />
  <meta property="og:url" content="${escapeHtml(site.url || '')}" />
  <link rel="canonical" href="${escapeHtml(site.url || '')}" />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E${encodeURIComponent(site.glyph || '◆')}%3C/text%3E%3C/svg%3E" />
  <script type="importmap">{"imports":{"anentrypoint-design":"${SDK_URL}"}}</script>
  <style>html,body{margin:0;padding:0}body{background:var(--app-bg,#FBF6EB);color:var(--ink,#1F1B16);font-family:var(--ff-ui,'Nunito',system-ui,sans-serif)}</style>
</head>
<body>
  <div id="app"></div>
  <script type="application/json" id="__site__">${escapeJson({ site, nav, home })}</script>
  <script type="module">${clientScript}</script>
</body>
</html>
`;

export default {
  render: async (ctx) => {
    const site = ctx.readGlobal('site') || {};
    const nav = ctx.readGlobal('navigation') || { links: [] };
    const homeDoc = ctx.read('pages').docs.find(p => p.id === 'home');
    if (!homeDoc) throw new Error('config/pages/home.yaml missing or has no id: home');

    return [{
      path: 'index.html',
      html: html({ site, nav, home: homeDoc })
    }];
  }
};
)),
    h('span', { class: 'cmd' }, l.text)
  ));
  return C.Panel({
    title: home.quickstart.heading || 'quick start',
    style: 'margin:8px',
    children: h('div', { style: 'padding:16px 22px' }, ...lineNodes)
  });
}

function Examples() {
  if (!home || !home.examples || !home.examples.items || !home.examples.items.length) return null;
  const rows = home.examples.items.map((it, i) => C.RowLink({
    key: 'e'+i,
    title: it.name,
    sub: it.desc || '',
    meta: it.cta || 'open',
    href: it.href || '#'
  }));
  return C.Panel({
    title: home.examples.heading || 'examples',
    style: 'margin:8px',
    children: rows
  });
}

function Footer() {
  return h('footer', { class: 'app-status' },
    h('span', { class: 'item' }, 'styled with '),
    h('a', { class: 'item', href: 'https://anentrypoint.github.io/design/' }, 'anentrypoint-design'),
    h('span', { class: 'item' }, '·'),
    h('a', { class: 'item', href: 'https://247420.xyz' }, '247420.xyz'),
    h('span', { class: 'spread' }),
    site.repo ? h('a', { class: 'item', href: site.repo }, 'source ↗') : null
  );
}

const navItems = (nav && nav.links ? nav.links : []).map(l => [String(l.label || ''), l.href]);

const App = C.AppShell({
  topbar: C.Topbar({
    brand: '247420',
    leaf: site.title || '',
    items: navItems
  }),
  crumb: C.Crumb({
    trail: ['247420'],
    leaf: site.title || ''
  }),
  main: h('div', {},
    Hero(),
    Features(),
    Quickstart(),
    Examples()
  ),
  status: Footer()
});

applyDiff(document.getElementById('app'), [App]);
`;

const html = ({ site, nav, home }) => `<!DOCTYPE html>
<html lang="en" class="ds-247420">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(site.title)}${site.tagline ? ' — ' + escapeHtml(site.tagline) : ''}</title>
  <meta name="description" content="${escapeHtml(site.description || site.tagline || site.title)}" />
  <meta property="og:title" content="${escapeHtml(site.title)}" />
  <meta property="og:description" content="${escapeHtml(site.description || site.tagline || '')}" />
  <meta property="og:url" content="${escapeHtml(site.url || '')}" />
  <link rel="canonical" href="${escapeHtml(site.url || '')}" />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E${encodeURIComponent(site.glyph || '◆')}%3C/text%3E%3C/svg%3E" />
  <script type="importmap">{"imports":{"anentrypoint-design":"${SDK_URL}"}}</script>
  <style>html,body{margin:0;padding:0}body{background:var(--app-bg,#FBF6EB);color:var(--ink,#1F1B16);font-family:var(--ff-ui,'Nunito',system-ui,sans-serif)}</style>
</head>
<body>
  <div id="app"></div>
  <script type="application/json" id="__site__">${escapeJson({ site, nav, home })}</script>
  <script type="module">${clientScript}</script>
</body>
</html>
`;

export default {
  render: async (ctx) => {
    const site = ctx.readGlobal('site') || {};
    const nav = ctx.readGlobal('navigation') || { links: [] };
    const homeDoc = ctx.read('pages').docs.find(p => p.id === 'home');
    if (!homeDoc) throw new Error('config/pages/home.yaml missing or has no id: home');

    return [{
      path: 'index.html',
      html: html({ site, nav, home: homeDoc })
    }];
  }
};
