// AnEntrypoint design-system theme for flatspace.
// Renders the full landing via the anentrypoint-design SDK — Topbar + Side
// (sidebar bins / labels / more) + Crumb + main panels (hero, kits, desktop_os,
// web_components, api_exports, decks, docs, previews, features, quickstart,
// examples) + Status. No hand-rolled
// HTML inside #app; every node comes from window.ds (C.* components).

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const escapeJson = (obj) => JSON.stringify(obj)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(new RegExp('\\u2028', 'g'), '\\u2028').replace(new RegExp('\\u2029', 'g'), '\\u2029');

const SDK_URL = 'https://unpkg.com/anentrypoint-design@latest/dist/247420.js';

const clientScript = `
import { h, applyDiff, installStyles, components as C, initTheme } from 'anentrypoint-design';
installStyles();
document.documentElement.classList.add('ds-247420');
// initTheme picks up data-theme on <html>, reapplies stored override from
// localStorage if present, and binds matchMedia so OS-level dark-mode flips
// re-emit to listeners. Safe no-op if data-theme is already 'auto'.
try { initTheme && initTheme(); } catch {}

const __reveal = () => document.documentElement.classList.add('ds-ready');
const __fallback = setTimeout(__reveal, 1500);

const data = JSON.parse(document.getElementById('__site__').textContent);
const { site, nav, home } = data;

function Hero() {
  if (!home || !home.hero) return null;
  const hero = home.hero;
  return C.Panel({
    style: 'margin:8px',
    children: h('div', { style: 'padding:24px 22px' },
      C.Heading({ level: 1, style: 'margin:0 0 8px 0', children: hero.heading || site.title }),
      hero.subheading ? C.Lede({ children: hero.subheading }) : null,
      hero.body ? h('p', { style: 'margin:8px 0 16px 0;color:var(--panel-text-2);max-width:64ch' }, hero.body) : null,
      (hero.badges && hero.badges.length) ? h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px 0' },
        ...hero.badges.map((b, i) => C.Chip({ key: 'b' + i, children: b.label }))
      ) : null,
      (hero.ctas && hero.ctas.length) ? h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
        ...hero.ctas.map((c, i) => C.Btn({ key: 'c' + i, href: c.href, primary: c.primary, children: c.label }))
      ) : null
    )
  });
}

function rowsFromItems(items, prefix) {
  return items.map((it, i) => C.RowLink({
    key: prefix + i,
    code: it.code || String(i + 1).padStart(2, '0'),
    title: it.title || it.name,
    sub: it.sub || it.desc || '',
    meta: it.cta || it.meta || 'open ↗',
    href: it.href || '#'
  }));
}

function Kits() {
  if (!home.kits || !home.kits.items || !home.kits.items.length) return null;
  return C.Panel({
    title: home.kits.heading || 'ui kits',
    count: home.kits.count || home.kits.items.length,
    style: 'margin:8px',
    children: rowsFromItems(home.kits.items, 'k')
  });
}

function Decks() {
  if (!home.decks || !home.decks.items || !home.decks.items.length) return null;
  return C.Panel({
    title: home.decks.heading || 'decks',
    style: 'margin:8px',
    children: rowsFromItems(home.decks.items, 'd')
  });
}

function FileBrowser() {
  if (!home.file_browser || !home.file_browser.items || !home.file_browser.items.length) return null;
  return C.Panel({
    title: home.file_browser.heading || 'file browser',
    count: home.file_browser.count || home.file_browser.items.length,
    style: 'margin:8px',
    children: rowsFromItems(home.file_browser.items, 'fb')
  });
}

function Docs() {
  if (!home.docs || !home.docs.items || !home.docs.items.length) return null;
  return C.Panel({
    title: home.docs.heading || 'docs',
    style: 'margin:8px',
    children: rowsFromItems(home.docs.items, 'doc')
  });
}

function Previews() {
  if (!home.previews || !home.previews.items || !home.previews.items.length) return null;
  const base = home.previews.base || './preview/';
  const rows = home.previews.items.map((name, i) => C.RowLink({
    key: 'p' + i,
    code: String(i + 1).padStart(2, '0'),
    title: String(name).replace(/-/g, ' '),
    sub: 'preview - ' + name + '.html',
    meta: 'open ↗',
    href: base + name + '.html'
  }));
  return C.Panel({
    title: home.previews.heading || 'previews',
    count: rows.length,
    style: 'margin:8px',
    children: rows
  });
}

function Features() {
  if (!home.features || !home.features.items || !home.features.items.length) return null;
  const rows = home.features.items.map((it, i) => C.RowLink({
    key: 'f' + i,
    code: String(i + 1).padStart(2, '0'),
    title: it.name,
    sub: it.desc || '',
    meta: it.meta || '',
    href: it.href || '#'
  }));
  return C.Panel({
    title: home.features.heading || 'why design',
    style: 'margin:8px',
    children: rows
  });
}

function Quickstart() {
  if (!home.quickstart || !home.quickstart.lines || !home.quickstart.lines.length) return null;
  const lineNodes = home.quickstart.lines.map((l, i) => h('div', { key: 'q' + i, class: 'cli' },
    h('span', { class: 'prompt' }, l.kind === 'cmt' ? '#' : '$'),
    h('span', { class: 'cmd' }, l.text)
  ));
  return C.Panel({
    title: home.quickstart.heading || 'quick start',
    style: 'margin:8px',
    children: h('div', { style: 'padding:16px 22px;display:flex;flex-direction:column;gap:6px' }, ...lineNodes)
  });
}

function DesktopOS() {
  if (!home.desktop_os || !home.desktop_os.items || !home.desktop_os.items.length) return null;
  return C.Panel({
    title: home.desktop_os.heading || 'desktop os shell',
    count: home.desktop_os.count || home.desktop_os.items.length,
    style: 'margin:8px',
    children: rowsFromItems(home.desktop_os.items, 'os')
  });
}

function WebComponents() {
  if (!home.web_components || !home.web_components.items || !home.web_components.items.length) return null;
  return C.Panel({
    title: home.web_components.heading || 'web components',
    count: home.web_components.count || home.web_components.items.length,
    style: 'margin:8px',
    children: rowsFromItems(home.web_components.items, 'wc')
  });
}

function ApiExports() {
  if (!home.api_exports || !home.api_exports.items || !home.api_exports.items.length) return null;
  return C.Panel({
    title: home.api_exports.heading || 'public api',
    count: home.api_exports.count || home.api_exports.items.length,
    style: 'margin:8px',
    children: rowsFromItems(home.api_exports.items, 'api')
  });
}

function Examples() {
  if (!home.examples || !home.examples.items || !home.examples.items.length) return null;
  return C.Panel({
    title: home.examples.heading || 'live examples',
    count: home.examples.items.length,
    style: 'margin:8px',
    children: rowsFromItems(home.examples.items, 'e')
  });
}

function buildSide() {
  const sb = home.sidebar || {};
  const sections = [];
  if (sb.fab) {
    sections.push({
      group: 'open',
      items: [{ glyph: sb.fab.glyph || '✦', label: sb.fab.label || 'open', href: sb.fab.href || '#' }]
    });
  }
  if (sb.bins && sb.bins.length) {
    sections.push({ group: 'bins', items: sb.bins });
  }
  if (sb.labels && sb.labels.length) {
    sections.push({ group: sb.labels_group || 'labels', items: sb.labels });
  }
  if (sb.more && sb.more.length) {
    sections.push({ group: sb.more_group || 'more', items: sb.more });
  }
  return C.Side({ sections });
}

function Tabs() {
  if (!home.tabs || !home.tabs.length) return null;
  return h('div', { class: 'tabs', role: 'tablist', style: 'margin:8px' },
    ...home.tabs.map((t, i) => h('a', {
      key: 't' + i,
      href: t.href || '#',
      class: t.active ? 'active' : '',
      role: 'tab'
    },
      t.glyph ? h('span', { class: 'glyph' }, t.glyph) : null,
      h('span', {}, t.label)
    ))
  );
}

const navItems = (nav && nav.links ? nav.links : []).map(l => [String(l.label || ''), l.href]);

const statusLeft = home.status_left || ['main', '- utf-8', '- lf'];
const statusRight = home.status_right || ['247420 / mmxxvi', '- probably emerging'];

const App = C.AppShell({
  topbar: C.Topbar({
    brand: '247420',
    leaf: site.title || 'design',
    items: navItems
  }),
  crumb: C.Crumb({ trail: ['247420'], leaf: site.title || 'design' }),
  side: buildSide(),
  main: h('div', {},
    Hero(),
    Tabs(),
    Kits(),
    FileBrowser(),
    DesktopOS(),
    WebComponents(),
    ApiExports(),
    Decks(),
    Docs(),
    Previews(),
    Features(),
    Quickstart(),
    Examples()
  ),
  status: C.Status({ left: statusLeft, right: statusRight })
});

applyDiff(document.getElementById('app'), [App]);

const __fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
Promise.race([__fontsReady, new Promise(r => setTimeout(r, 1200))]).then(() => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clearTimeout(__fallback);
    __reveal();
  }));
});
`;

const html = ({ site, nav, home }) => {
  const title = `${escapeHtml(site.title)}${site.tagline ? ' — ' + escapeHtml(site.tagline) : ''}`;
  const desc = escapeHtml(site.description || site.tagline || site.title);
  const url = escapeHtml(site.url || '');
  const image = escapeHtml(site.image || (site.url ? site.url.replace(/\/$/, '') + '/og-card.png' : ''));
  const siteName = escapeHtml(site.siteName || site.title);
  const author = escapeHtml(site.author || '247420 / AnEntrypoint');
  const twitter = escapeHtml(site.twitter || '@AnEntrypoint');
  const keywords = escapeHtml((site.keywords && site.keywords.join(', ')) || '247420, anentrypoint, design system');
  const locale = escapeHtml(site.locale || 'en_US');
  const lang = escapeHtml(site.lang || 'en');
  const ldJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: site.title || '',
    alternateName: site.siteName || undefined,
    url: site.url || '',
    description: site.description || site.tagline || '',
    inLanguage: site.lang || 'en',
    publisher: {
      '@type': 'Organization',
      name: site.author || '247420 / AnEntrypoint',
      url: 'https://247420.xyz'
    }
  }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="${lang}" class="ds-247420" data-theme="auto">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <meta name="description" content="${desc}" />
  <meta name="keywords" content="${keywords}" />
  <meta name="author" content="${author}" />
  <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1" />
  <meta name="referrer" content="strict-origin-when-cross-origin" />
  <meta name="generator" content="anentrypoint-design" />
  <meta name="theme-color" content="#247420" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#3A9A34" media="(prefers-color-scheme: dark)" />
  <meta name="color-scheme" content="light dark" />
  <meta name="application-name" content="${siteName}" />
  <meta name="apple-mobile-web-app-title" content="${siteName}" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="msapplication-TileColor" content="#247420" />
  <meta http-equiv="content-language" content="${lang}" />
  <link rel="canonical" href="${url}" />
  <link rel="alternate" hreflang="${lang}" href="${url}" />
  <link rel="alternate" hreflang="x-default" href="${url}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(site.title)}" />
  <meta property="og:description" content="${escapeHtml(site.description || site.tagline || '')}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:site_name" content="${siteName}" />
  <meta property="og:locale" content="${locale}" />
  ${image ? `<meta property="og:image" content="${image}" />
  <meta property="og:image:secure_url" content="${image}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${escapeHtml(site.title)}" />` : ''}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(site.title)}" />
  <meta name="twitter:description" content="${escapeHtml(site.description || site.tagline || '')}" />
  <meta name="twitter:site" content="${twitter}" />
  <meta name="twitter:creator" content="${twitter}" />
  ${image ? `<meta name="twitter:image" content="${image}" />
  <meta name="twitter:image:alt" content="${escapeHtml(site.title)}" />` : ''}
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E${encodeURIComponent(site.glyph || '◆')}%3C/text%3E%3C/svg%3E" />
  <link rel="apple-touch-icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E${encodeURIComponent(site.glyph || '◆')}%3C/text%3E%3C/svg%3E" />
  <script type="application/ld+json">${ldJson}</script>
  <script type="importmap">{"imports":{"anentrypoint-design":"${SDK_URL}"}}</script>
  <link rel="stylesheet" href="https://unpkg.com/anentrypoint-design@latest/dist/247420.css">
  <link rel="preconnect" href="https://unpkg.com" crossorigin>
  <link rel="dns-prefetch" href="https://unpkg.com">
  <style>html,body{margin:0;padding:0}body{background:var(--app-bg,#FBF6EB);color:var(--ink,#1F1B16);font-family:var(--ff-ui,'Nunito',system-ui,sans-serif)}html:not(.ds-ready) body{visibility:hidden}html.ds-ready body{visibility:visible;animation:ds-fade-in .18s ease-out both}@keyframes ds-fade-in{from{opacity:0}to{opacity:1}}</style>
  <noscript><style>html body{visibility:visible !important}</style></noscript>
</head>
<body>
  <div id="app"></div>
  <script type="application/json" id="__site__">${escapeJson({ site, nav, home })}</script>
  <script type="module">${clientScript}</script>
</body>
</html>
`;
};

export default {
  render: async (ctx) => {
    const site = ctx.readGlobal('site') || {};
    const nav = ctx.readGlobal('navigation') || { links: [] };
    const homeDoc = ctx.read('pages').docs.find(p => p.id === 'home');
    if (!homeDoc) throw new Error('site/content/pages/home.yaml missing or has no id: home');

    return [{
      path: 'index.html',
      html: html({ site, nav, home: homeDoc })
    }];
  }
};
