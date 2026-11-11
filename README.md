# Critical CSS Generator

Batch generator of first-fold critical CSS, split into a mobile block
(`max-width: 991.98px`) and a desktop block (`min-width: 992px`) ready to paste
into a CMS block (e.g. a Drupal custom block with Full HTML). It also validates
a generated block visually against the live page before you publish it.

## Features

- **Batch processing**: many URLs per job, 3 at a time, never two requests to
  the same hostname in parallel.
- **Individual or combined viewports**: one file per viewport, or one sheet
  unioned across viewports.
- **Budget audit**: gzip size of each block against the initial TCP congestion
  window.
- **Visual validation**: injects the block into the real page and compares
  computed styles and screenshots (first paint and final cascade).
- **Settings center**: project-specific filters, proxies and browser options
  edited from the UI, stored outside git.
- **Blocked-page detection** with fallbacks (clean context, proxy, manual
  capture from your own browser).

## Installation

Requires **Node.js 24+** (see `.tool-versions`) and a Linux, macOS or Windows
machine (WSL works).

```bash
npm install            # also applies patches/ and downloads the browser
npm run browsers:deps  # Linux/WSL only, once: system libraries for Chromium (uses sudo)
npm run dev
```

The UI runs on http://localhost:9000 (Vite) and proxies `/api` to the Express
server on port 9001.

### Browser and system packages

Everything runs on **Playwright**: page captures, visual validation and the
`critical` render engine share a single Chromium headless shell, downloaded by
`npm run browsers` (run automatically on `postinstall`; npm 11 no longer runs
the dependencies' own install scripts).

Chromium is not a static binary: on Linux it links against system libraries
(NSS, GTK/ATK, X11/xcb, ALSA, GBM, fontconfig...). There is no need to list
them by hand: `npm run browsers:deps` (`playwright install-deps chromium`)
installs exactly the packages your distribution needs. macOS and Windows need
nothing extra. If you pick the full Chromium or an installed Chrome in the
settings center, install it with `npx playwright install chromium` or use the
system browser.

## Settings center

The **Configurações** tab edits `critical.config.json` at the project root
(git-ignored; copy `critical.config.example.json` to start by hand). Changes
apply to the next capture without restarting the server; browser changes
reopen the browser. Set `CRITICAL_CSS_CONFIG=/path/file.json` to switch
between setups.

| Key | Purpose |
| --- | --- |
| `ignoredStylesheets` | URL substrings of stylesheets never fed to the critical CSS (icon libraries, print sheets, widgets) |
| `ignoredSelectorPatterns` | Case-insensitive RegExps; matching selectors are dropped from the result |
| `defaultExcludedSelectors` | Selectors pre-filled in the "Gerar" tab: removed from the snapshot and from the result |
| `acceptLanguage` | `Accept-Language` header for page visits |
| `urlPlaceholder` | Example URL shown in the UI |
| `proxies` | `{ "hostname": "http://user:pass@host:port" }`, used when direct access is blocked |
| `browser.channel` | Empty = Playwright headless shell; `chromium`, `chrome` or `msedge` |
| `browser.launchArgs` | Extra Chromium flags |
| `hooksFile` | Optional browser hooks module (below) |

Proxy passwords are masked in the UI; leaving `********` in place keeps the
stored password. A legacy `proxies.json` at the root is still read when the
config has no `proxies`.

### Browser hooks

`hooksFile` (default `local/browser-hooks.js`, the `local/` folder is
git-ignored) can export any of:

```js
export const launchArgs = ['--lang=pt-BR'];             // extra Chromium flags
export function contextOptions(browserVersion) {         // merged into newContext()
  return { locale: 'pt-BR' };
}
export async function setupPage(page, { context }) {}    // before page.goto()
export async function afterNavigation(page, { context }) {} // right after page.goto()
```

If `contextOptions` returns a `userAgent`, the same UA is handed to
`critical`, so pages that style by UA render the same way in both steps.

## Blocked pages (WAF / anti-bot)

Every visit is checked for known WAF/challenge signals (Akamai, Cloudflare,
Incapsula and similar) before any CSS is generated, so a blocked page never
silently produces garbage CSS. Per URL, the app tries in order:

1. **Direct** — the shared browser context (cookies persisted in
   `data/browser-state.json`)
2. **Clean context** — no persisted cookies
3. **Proxy** — the domain's proxy from the settings center, if any
4. **Manual capture** — HTML captured from your own browser with the
   bookmarklet in the "Captura manual" section

When a WAF-free environment exists (staging, a hosting preview domain),
prefer generating from it: same-origin asset URLs come out root-relative, so
the block works on production. The outcome of each visit is remembered per
hostname (`data/domain-strategy.json`).

## API

```
POST   /api/critical/batch              { urls, configs, combineDimensions, excludedSelectors, ... }
GET    /api/critical/batch/:jobId
POST   /api/critical/batch/:jobId/retry
POST   /api/critical                    single URL
POST   /api/capture  { url, html }  ·  GET /api/capture  ·  DELETE /api/capture { url }
GET    /api/domain-info?url=...
POST   /api/validate { url, blockHtml, position? }  ·  GET /api/validate/:jobId
GET    /api/settings  ·  PUT /api/settings { values }
GET    /api/health
```

Example batch request:

```javascript
await fetch('/api/critical/batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    urls: ['https://example.com', 'https://example.org'],
    configs: [
      { width: 393, height: 852, device: 'mobile', name: 'Mobile' },
      { width: 1920, height: 1080, device: 'desktop', name: 'Desktop' },
    ],
    combineDimensions: false,
  }),
});
```

Batch history survives a restart (`data/jobs.json`); finished jobs older than
one hour are cleaned up.

## How generation works

1. **Snapshot** (`lib/browser-manager.js`) — Playwright visits the page and
   collects every stylesheet over CDP into one self-contained HTML snapshot.
   `@import`ed sheets are inlined at their import position, relative `url()`s
   are rebased, and Shadow DOM styles are left out (flattened into the
   document they would leak onto every matching element).
2. **Critical extraction** (`lib/critical-generator.js`) — the snapshot is
   rendered by [critical](https://github.com/addyosmani/critical) 9's `render`
   engine at each viewport. Before that, scripts, inline handlers and meta
   refreshes are stripped (the DOM is already rendered), iframes are blanked,
   and a `<base href>` keeps relative images sized as on the real page.
   critical 9 has no `ignore` option, so `@font-face`, `@keyframes`,
   animation/transition declarations, SVG references, large data URIs and the
   excluded selectors are removed from its output afterwards.
3. **Page fixes** (`lib/page-fixes.js`) — CLS fixes for known third-party
   scripts (Google Publisher Tag top anchor, OneTrust banner), added only when
   the page loads them.
4. **Optimization** (`lib/css-optimizer.js`) — PostCSS + cssnano pruning and
   the gzip budget audit.
5. **Cascade layer** — the result is wrapped in `@layer critical { … }`.
   Layered rules always lose to the page's own unlayered CSS, so the block can
   sit anywhere in the document without re-asserting rules the page overrides
   later. Keep in mind:
   - Supported since 2022 (Chrome/Edge 99, Firefox 97, Safari 15.4); older
     browsers ignore the block (no critical CSS, final page still correct).
   - Inside a layer `!important` flips: a layered `!important` beats the
     page's unlayered `!important`. The flags are kept anyway, since dropping
     them breaks the first paint (utilities like `.hidden{display:none!important}`).

   Pass `cascadeLayer: null` to `optimizeCriticalCSS` to get the bare CSS.

### Local patch to critical

`critical` is pinned to `9.0.0` and patched via
[patch-package](https://github.com/ds300/patch-package)
(`patches/critical+9.0.0.patch`, applied on `postinstall`). Its render engine
only kept rules for elements whose box intersects the viewport, which drops
the rules that **hide or move elements out of the fold** (`display:none`
menus and slideshows, off-screen skip links), so they showed up at first
paint. The patch judges a hidden element by its nearest rendered ancestor and
uses penthouse's "starts before the fold ends" criterion. When upgrading
critical, check whether upstream fixed this; if not, re-create the patch with
`npx patch-package critical`.
