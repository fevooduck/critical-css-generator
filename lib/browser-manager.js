import { chromium } from 'playwright';
import postcss from 'postcss';
import { detectBlock } from './block-detector.js';
import { config, loadBrowserHooks } from './app-config.js';
import { readJson, writeJson } from './json-store.js';

const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

// Cookies and localStorage of the shared context, persisted between runs
// (consent choices, session cookies), in data/.
const STORAGE_STATE_FILE = 'browser-state.json';

// Stylesheets never fed to critical CSS generation (sprite/icon libraries,
// print sheets, third-party widgets), matched against the sheet's source URL.
// Configured per project in critical.config.json ("ignoredStylesheets").
function isIgnoredStylesheet(sourceURL) {
  return (
    !!sourceURL &&
    config.ignoredStylesheets.some((file) => sourceURL.includes(file))
  );
}

function ruleKey(rule) {
  const decls = rule.nodes
    .filter((n) => n.type === 'decl')
    .map((d) => `${d.prop}:${d.value.replace(/\s+/g, ' ').trim()}`)
    .join(';');
  return `${rule.selector.replace(/\s+/g, ' ').trim()}{${decls}}`;
}

function collectRuleKeys(cssTexts) {
  const keys = new Set();
  for (const css of cssTexts) {
    try {
      postcss.parse(css).walkRules((rule) => keys.add(ruleKey(rule)));
    } catch {
      // unparsable sheet: nothing to collect
    }
  }
  return keys;
}

function removeRules(css, keys) {
  if (keys.size === 0) return css;
  try {
    const root = postcss.parse(css);
    let removed = 0;
    root.walkRules((rule) => {
      if (keys.has(ruleKey(rule))) {
        rule.remove();
        removed++;
      }
    });
    return removed > 0 ? root.toString() : css;
  } catch {
    return css;
  }
}

// `@import url(x) [media];` → [url, media]. Imports with `layer`/`supports()`
// conditions aren't expanded (their cascade can't be kept by plain inlining).
function parseImport(params) {
  const m = params.match(
    /^\s*(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*(.*?)\s*$/i,
  );
  if (!m) return null;
  const media = m[5] || '';
  if (/\blayer\b|supports\s*\(/i.test(media)) return null;
  return { href: (m[2] || m[4]).trim(), media };
}

/**
 * CDP reports an @import'ed sheet as its own entry, listed *after* the sheet
 * that imports it. Merged into one <style>, the importer's leftover @import is
 * invalid (no longer at the top) and the imported rules land after the
 * importer's own, flipping the cascade — e.g. a body <style> that imports
 * bootstrap-grid and then sets `.container{max-width:1160px}` came out with
 * bootstrap's 1140px winning, so the header and page shifted sideways when
 * the full CSS loaded. Puts each imported sheet's text where its @import was
 * (wrapped in @media when the import had a media query) and drops its own
 * entry. Ignored stylesheets aren't pulled in: their @import is dropped and
 * they stay a separate entry, so they still never reach the critical CSS.
 *
 * @param {Array<{ header: object, text: string }>} sheets
 * @param {string} pageURL
 */
function inlineImportedSheets(sheets, pageURL) {
  const byUrl = new Map();
  for (const sheet of sheets) {
    if (!sheet.header.isInline && sheet.header.sourceURL) {
      byUrl.set(sheet.header.sourceURL, sheet);
    }
  }
  if (byUrl.size === 0) return sheets;

  const consumed = new Set();
  const expand = (sheet, depth) => {
    if (depth > 5 || !/@import/i.test(sheet.text)) return sheet.text;
    const base = sheet.header.sourceURL || pageURL;
    let root;
    try {
      root = postcss.parse(sheet.text);
    } catch {
      return sheet.text;
    }
    let changed = false;
    root.walkAtRules(/^import$/i, (atRule) => {
      const parsed = parseImport(atRule.params);
      if (!parsed) return;
      let href;
      try {
        href = new URL(parsed.href, base).href;
      } catch {
        return;
      }
      const imported = byUrl.get(href);
      if (!imported || imported === sheet) return;
      changed = true;
      if (isIgnoredStylesheet(href)) {
        atRule.remove();
        return;
      }
      consumed.add(imported);
      const text = rebaseCssUrls(expand(imported, depth + 1), href, pageURL);
      let replacement;
      try {
        replacement = postcss.parse(parsed.media ? `@media ${parsed.media}{${text}}` : text);
      } catch {
        consumed.delete(imported);
        return;
      }
      atRule.replaceWith(replacement.nodes);
    });
    return changed ? root.toString() : sheet.text;
  };

  const expanded = sheets.map((sheet) => ({ ...sheet, text: expand(sheet, 0) }));
  if (consumed.size > 0) {
    console.log(`  🔗 Inlined ${consumed.size} @import'ed stylesheet(s) at their @import position`);
  }
  return expanded.filter((_, i) => !consumed.has(sheets[i]));
}

// Once every sheet is merged into one inline <style>, relative url()s would
// resolve against the page instead of the CSS file they came from
// (e.g. `url(../img/svgs/x.svg)` from /css/main.css). Resolve them against
// the sheet's own URL while we still know it. Assets on the page's own
// origin become root-relative (`/themes/...`) rather than absolute, so a
// block generated from a mirror or staging host (e.g. a WAF-free
// environment) never points production at that host. Other origins (CDNs)
// stay absolute.
function rebaseCssUrls(css, sourceURL, pageURL) {
  if (!sourceURL || !/^https?:/i.test(sourceURL)) return css;
  let pageOrigin = null;
  try {
    pageOrigin = new URL(pageURL).origin;
  } catch {
    // no page origin: fall back to absolute URLs
  }
  return css.replace(
    /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi,
    (match, quote, ref) => {
      if (/^(data:|blob:|#|[a-z][a-z0-9+.-]*:)/i.test(ref.trim())) return match;
      try {
        const resolved = new URL(ref.trim(), sourceURL);
        const value =
          resolved.origin === pageOrigin
            ? `${resolved.pathname}${resolved.search}${resolved.hash}`
            : resolved.href;
        return `url(${quote}${value}${quote})`;
      } catch {
        return match;
      }
    },
  );
}

const DEFAULT_VIEWPORT = { width: 1366, height: 768 };
// Lets late scripts (hydration, web fonts) settle the first fold.
const SETTLE_DELAY_MS = 1200;
const NETWORK_IDLE_TIMEOUT_MS = 10000;
const SCROLL_STEPS = 3;
const SCROLL_STEP_DELAY_MS = 350;

let browserPromise = null;
let sharedContextPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const hooks = await loadBrowserHooks();
      const browser = await chromium.launch({
        headless: true,
        channel: config.browser.channel,
        args: [...LAUNCH_ARGS, ...config.browser.launchArgs, ...(hooks.launchArgs || [])],
      });
      browser.once('disconnected', () => {
        browserPromise = null;
        sharedContextPromise = null;
      });
      return browser;
    })().catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

async function baseContextOptions(browser) {
  const hooks = await loadBrowserHooks();
  const fromHooks = hooks.contextOptions
    ? (await hooks.contextOptions(browser.version())) || {}
    : {};
  return {
    ignoreHTTPSErrors: true,
    viewport: DEFAULT_VIEWPORT,
    ...(config.acceptLanguage
      ? { extraHTTPHeaders: { 'accept-language': config.acceptLanguage } }
      : {}),
    ...fromHooks,
  };
}

function parseProxyUrl(proxyUrl) {
  const parsed = new URL(proxyUrl);
  return {
    server: `${parsed.protocol}//${parsed.host}`,
    ...(parsed.username
      ? {
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        }
      : {}),
  };
}

// Shared across the whole batch job: one browser and one context for every
// visit and visual validation, its cookies/localStorage persisted to
// data/browser-state.json between runs.
export function getSharedContext() {
  if (!sharedContextPromise) {
    sharedContextPromise = (async () => {
      const browser = await getBrowser();
      const storageState = await readJson(STORAGE_STATE_FILE, undefined).catch(() => undefined);
      return browser.newContext({ ...(await baseContextOptions(browser)), storageState });
    })().catch((error) => {
      sharedContextPromise = null;
      throw error;
    });
  }
  return sharedContextPromise;
}

async function persistSharedState(context) {
  try {
    await writeJson(STORAGE_STATE_FILE, await context.storageState());
  } catch (error) {
    console.warn(`  ⚠️ Failed to persist browser state: ${error.message}`);
  }
}

// A throwaway context: no persisted cookies, optionally through a
// domain-specific proxy (Playwright applies proxies per context).
async function createIsolatedContext({ proxyUrl = null } = {}) {
  const browser = await getBrowser();
  return browser.newContext({
    ...(await baseContextOptions(browser)),
    ...(proxyUrl ? { proxy: parseProxyUrl(proxyUrl) } : {}),
  });
}

// User agent the pages were captured with, handed to critical so pages that
// style by UA render the same way there. Undefined = the browser default.
export async function getUserAgent() {
  const options = await baseContextOptions(await getBrowser());
  return options.userAgent;
}

export async function preparePageWithHooks(page, context) {
  const hooks = await loadBrowserHooks();
  if (hooks.setupPage) await hooks.setupPage(page, { context });
}

export async function closeSharedBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  sharedContextPromise = null;
  if (browser) await browser.close().catch(() => {});
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Media queries of the two <style> blocks this tool generates for Drupal
// (see buildHtmlMediaBlock in main.js). A page that already carries a
// previous run's block must not feed it back into the new critical CSS,
// wherever it sits (a Drupal block region renders inside <body>).
export const GENERATED_BLOCK_MEDIA = [
  '(max-width: 991.98px)',
  '(min-width: 992px)',
];

const normalizeMedia = (media) =>
  (media || '').replace(/\s+/g, '').toLowerCase();
const GENERATED_MEDIA_KEYS = new Set(GENERATED_BLOCK_MEDIA.map(normalizeMedia));

// CSS.styleSheetAdded only tells us a sheet is inline, not where its <style>
// lives or which media it was given, so ask the DOM about the owner node.
async function describeInlineOwner(client, backendNodeId) {
  const unknown = { inHead: false, media: null };
  if (!backendNodeId) return unknown;
  try {
    const { object } = await client.send('DOM.resolveNode', { backendNodeId });
    const { result } = await client.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        return {
          inHead: !!(this.closest && this.closest("head")),
          inShadow: this.getRootNode() instanceof ShadowRoot,
          media: this.getAttribute ? this.getAttribute("media") : null,
        };
      }`,
      returnByValue: true,
    });
    await client
      .send('Runtime.releaseObject', { objectId: object.objectId })
      .catch(() => {});
    return result.value || unknown;
  } catch {
    return unknown;
  }
}

// Optional pass to surface lazy content if requested (disabled by default for pure critical CSS)
async function triggerLazyContent(page) {
  try {
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    for (let step = 1; step <= SCROLL_STEPS; step += 1) {
      await page.evaluate(
        (y) => window.scrollTo(0, y),
        Math.round((scrollHeight / SCROLL_STEPS) * step),
      );
      await delay(SCROLL_STEP_DELAY_MS);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(SCROLL_STEP_DELAY_MS);
  } catch {
    // non-fatal
  }
}

/**
 * Visits `url` with the shared browser: checks the response for WAF/anti-bot
 * challenge pages and captures a fully self-contained snapshot with inline
 * stylesheets ready for critical's render engine.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeout=30000]
 * @param {object} [opts.viewport=DEFAULT_VIEWPORT]
 * @param {string|null} [opts.proxyUrl=null]
 * @param {boolean} [opts.isolateFirstFold=true] - When true, skips full-page scrolling to avoid below-the-fold contamination
 * @param {boolean} [opts.ignoreHeadInlineStyles=false] - When true, <style> tags inside <head> are left out of the critical CSS input
 * @param {boolean} [opts.freshContext=false] - When true, visits from an isolated context with no persisted cookies
 */
export async function visitUrl(
  url,
  {
    timeout = 30000,
    viewport = DEFAULT_VIEWPORT,
    proxyUrl = null,
    isolateFirstFold = true,
    ignoreHeadInlineStyles = false,
    freshContext = false,
  } = {},
) {
  let isolatedContext = null;
  let page = null;
  let client = null;
  const styleSheetHeaders = new Map();

  try {
    if (proxyUrl || freshContext) {
      isolatedContext = await createIsolatedContext({ proxyUrl });
    }
    const context = isolatedContext || (await getSharedContext());
    page = await context.newPage();
    await page.setViewportSize(viewport);
    client = await context.newCDPSession(page);

    client.on('CSS.styleSheetAdded', (event) => {
      styleSheetHeaders.set(event.header.styleSheetId, event.header);
    });

    await client.send('DOM.enable');
    await client.send('CSS.enable');

    const hooks = await loadBrowserHooks();
    if (hooks.setupPage) await hooks.setupPage(page, { context });

    const response = await page.goto(url, { waitUntil: 'load', timeout });
    // Playwright's networkidle waits for zero connections; pages with
    // long-polling or analytics beacons never get there, so it's best-effort.
    await page
      .waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS })
      .catch(() => {});
    await delay(SETTLE_DELAY_MS);

    if (hooks.afterNavigation) await hooks.afterNavigation(page, { context });
    if (!isolatedContext) await persistSharedState(context);

    const [html, title] = await Promise.all([page.content(), page.title()]);
    const status = response ? response.status() : 0;
    const headers = response ? response.headers() : {};

    const blockResult = detectBlock({ status, headers, html, title });

    if (blockResult.blocked) {
      return { blockResult, html: null, css: null };
    }

    // Only scroll if explicitly requested; otherwise keep strictly First Fold pure
    if (!isolateFirstFold) {
      await triggerLazyContent(page);
    }

    // Shadow DOM styles (a <style> inside a shadow root, or a constructed
    // sheet adopted by a web component) are scoped to their component;
    // flattened into the document they leak onto every matching element
    // (e.g. a component's `a{display:grid}` hits every link on the page).
    // Constructed sheets are only kept when the document itself adopts some,
    // since they can't be told apart from the component ones here.
    const documentAdoptsSheets = await page
      .evaluate(() => document.adoptedStyleSheets.length > 0)
      .catch(() => true);
    let shadowSheets = 0;

    const capturedSheets = [];
    for (const header of styleSheetHeaders.values()) {
      try {
        if (header.isConstructed && !documentAdoptsSheets) {
          shadowSheets++;
          continue;
        }
        const { text } = await client.send('CSS.getStyleSheetText', {
          styleSheetId: header.styleSheetId,
        });
        if (!text || !text.trim()) continue;
        const owner = header.isInline
          ? await describeInlineOwner(client, header.ownerNode)
          : { inHead: false, inShadow: false, media: null };
        if (owner.inShadow) {
          shadowSheets++;
          continue;
        }
        capturedSheets.push({
          header,
          text,
          inHead: owner.inHead,
          isGeneratedBlock: GENERATED_MEDIA_KEYS.has(normalizeMedia(owner.media)),
        });
      } catch {
        // skip unparsable sheets (e.g. UA default sheet)
      }
    }

    const sheets = inlineImportedSheets(capturedSheets, url);

    if (shadowSheets > 0) {
      console.log(`  🧩 Ignoring ${shadowSheets} Shadow DOM stylesheet(s) (scoped to web components)`);
    }

    const generatedBlocks = sheets.filter((s) => s.isGeneratedBlock);
    if (generatedBlocks.length > 0) {
      console.log(
        `  ♻️  Ignoring ${generatedBlocks.length} critical CSS block(s) from a previous run (<style media="${GENERATED_BLOCK_MEDIA.join('" / "')}">)`,
      );
    }

    if (ignoreHeadInlineStyles) {
      const skipped = sheets.filter((s) => s.inHead && !s.isGeneratedBlock);
      if (skipped.length > 0) {
        console.log(
          `  🙈 Ignoring ${skipped.length} inline <style> tag(s) from <head> (${(
            skipped.reduce((sum, s) => sum + s.text.length, 0) / 1024
          ).toFixed(1)}KB)`,
        );
      }
    }

    const ignoredRules = collectRuleKeys(
      sheets
        .filter(({ header }) => isIgnoredStylesheet(header.sourceURL))
        .map(({ text }) => text),
    );

    const externalRules = collectRuleKeys(
      sheets
        .filter(({ header }) => !header.isInline)
        .map(({ text }) => text),
    );

    const cssChunks = [];
    const criticalCssChunks = [];
    for (const { header, text, inHead, isGeneratedBlock } of sheets) {
      // A previous run's critical block isn't the page's CSS: keep it out of
      // the full-CSS export too.
      if (isGeneratedBlock) continue;
      const sourceURL = header.sourceURL || url;
      cssChunks.push(rebaseCssUrls(text, sourceURL, url));
      if (ignoreHeadInlineStyles && inHead) continue;
      if (!isIgnoredStylesheet(header.sourceURL)) {
        let critical = removeRules(text, ignoredRules);
        if (header.isInline) critical = removeRules(critical, externalRules);
        criticalCssChunks.push(rebaseCssUrls(critical, sourceURL, url));
      }
    }

    // Inlines all page CSS so `critical` never re-fetches stylesheets itself
    await page.evaluate((css) => {
      document
        .querySelectorAll('link[rel="stylesheet"], link[rel="preload"][as="style"], style')
        .forEach((el) => el.remove());
      const style = document.createElement('style');
      style.textContent = css;
      document.head.prepend(style);
    }, criticalCssChunks.join('\n'));

    const selfContainedHtml = await page.content();

    return { blockResult, html: selfContainedHtml, css: cssChunks.join('\n') };
  } catch (error) {
    return {
      blockResult: {
        blocked: true,
        confidence: 'medium',
        provider: null,
        reason: `Falha ao carregar a página: ${error.message}`,
        matchedSignals: ['navigation_error'],
        status: 0,
      },
      html: null,
      css: null,
    };
  } finally {
    if (client) await client.detach().catch(() => {});
    if (page) await page.close().catch(() => {});
    if (isolatedContext) await isolatedContext.close().catch(() => {});
  }
}
