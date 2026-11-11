import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import * as cheerio from 'cheerio';
import postcss from 'postcss';
import { critical } from 'critical';
import { filterCssByExcludedRules } from './html-cleaner.js';

// critical's render engine loads the snapshot with setContent and waits for
// network idle, which includes every image and font the page references.
const RENDER_TIMEOUT_MS = 120000;

/**
 * Makes the self-contained snapshot from visitUrl safe and faithful to render
 * in critical's own Playwright browser:
 * - the DOM is already rendered, so scripts would only re-run against it
 *   (re-rendering, consent banners, redirects) — they are removed, along with
 *   inline handlers and meta refreshes;
 * - setContent runs on about:blank, so a <base href> keeps relative images
 *   loading and sized like on the real page;
 * - iframes keep their box but don't load (embeds hold network idle open);
 * - the <style> contents are moved out and returned as `css`: critical
 *   re-injects every <style> it finds as an extra sheet, and the two copies
 *   come out of its dedupe pass in a scrambled cascade order.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{ html: string, css: string }}
 */
export function prepareSnapshot(html, pageUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const css = $('style')
    .map((_, el) => {
      const text = $(el).text();
      const media = $(el).attr('media');
      return media && media.trim() !== 'all' ? `@media ${media}{${text}}` : text;
    })
    .get()
    .join('\n');
  $('style').remove();

  $('script, meta[http-equiv="refresh" i]').remove();
  $('iframe').attr('src', 'about:blank').removeAttr('srcdoc');
  $('*').each((_, el) => {
    for (const name of Object.keys(el.attribs || {})) {
      if (/^on/i.test(name)) $(el).removeAttr(name);
    }
  });

  if (pageUrl && $('base[href]').length === 0) {
    $('head').prepend($('<base>').attr('href', pageUrl));
  }

  return { html: $.html(), css };
}

// Declarations that never belong in the inlined block: SVG references,
// animations/transitions (nothing animates before the full CSS loads) and
// large data URIs.
function isUnwantedDecl(decl) {
  return (
    /\.svg/i.test(decl.value) ||
    /animation|transition/i.test(decl.prop) ||
    (/data:(image|font)\//i.test(decl.value) && decl.value.length > 300)
  );
}

// critical 9 dropped the `ignore`/`forceExclude` options, so the same
// filtering runs on its output instead.
function stripIgnored(css, ignoreRules) {
  const root = postcss.parse(css);
  root.walkAtRules(/^(-\w+-)?(font-face|keyframes)$/i, (atRule) => atRule.remove());
  root.walkDecls((decl) => {
    if (isUnwantedDecl(decl)) decl.remove();
  });
  return filterCssByExcludedRules(root.toString(), ignoreRules);
}

/**
 * Extracts the critical CSS of a visitUrl snapshot for one or more viewports
 * (several dimensions are unioned into a single sheet).
 *
 * @param {object} params
 * @param {string} params.html - Self-contained snapshot (all CSS in one <style>)
 * @param {string} params.pageUrl - URL the snapshot was taken from
 * @param {Array<{width: number, height: number}>} params.dimensions
 * @param {string} [params.userAgent]
 * @param {RegExp[]} [params.ignoreRules] - Selectors to drop (see buildCssIgnoreRules)
 * @returns {Promise<string>}
 */
export async function generateCriticalCss({
  html,
  pageUrl,
  dimensions,
  userAgent,
  ignoreRules = [],
}) {
  const snapshot = prepareSnapshot(html, pageUrl);

  // Handed over as a file: critical treats a `css` string containing ".css?"
  // (e.g. `@import url(style.css?ver=6.4)`) as a path and would read nothing.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'critical-'));
  try {
    const cssFile = path.join(dir, 'snapshot.css');
    await writeFile(cssFile, snapshot.css);

    const { css, report } = await critical({
      html: snapshot.html,
      css: cssFile,
      base: dir,
      engine: 'render',
      dimensions,
      userAgent,
      timeout: RENDER_TIMEOUT_MS,
    });

    for (const warning of report.warnings) {
      console.warn(`  ⚠️ critical: ${warning}`);
    }

    return stripIgnored(css, ignoreRules);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
