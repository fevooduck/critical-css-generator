import { readJson, writeJson } from './json-store.js';

const FILE = 'manual-captures.json';

// Last-resort fallback for a domain that blocks every automated path: the user
// captures the page from their own real browser (bookmarklet) and the batch
// job uses that HTML instead of trying to visit the URL itself.
//
// Captures are keyed by a normalized URL so the one typed in the batch list
// still matches when it differs only by a #fragment or a trailing slash.
export function normalizeCaptureUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * @param {string} url
 * @param {{ html: string, sheets?: Array<{css: string, href: string|null, inHead: boolean}>, skippedSheets?: number, capturedAt?: string }} capture
 *   `sheets` comes from the current bookmarklet (styles kept apart from the
 *   DOM); older captures only have `html` with all CSS already inlined.
 */
export async function saveCapture(url, { html, sheets, skippedSheets = 0, capturedAt }) {
  const store = await readJson(FILE, {});
  store[normalizeCaptureUrl(url)] = {
    html,
    sheets: Array.isArray(sheets) ? sheets : null,
    skippedSheets,
    capturedAt: capturedAt || new Date().toISOString(),
  };
  await writeJson(FILE, store);
}

export async function getCapture(url) {
  const store = await readJson(FILE, {});
  return store[normalizeCaptureUrl(url)] || null;
}

export async function deleteCapture(url) {
  const store = await readJson(FILE, {});
  delete store[normalizeCaptureUrl(url)];
  await writeJson(FILE, store);
}

export async function listCaptures() {
  const store = await readJson(FILE, {});
  return Object.entries(store).map(([url, value]) => ({
    url,
    capturedAt: value.capturedAt,
    size:
      (value.html?.length || 0) +
      (value.sheets || []).reduce((sum, s) => sum + (s.css?.length || 0), 0),
    skippedSheets: value.skippedSheets || 0,
  }));
}

/**
 * Turns a stored capture into the self-contained HTML the critical CSS step
 * expects (all styles in one <style> at the top of <head>), honouring the
 * same "ignore inline <style> from <head>" option as a live visit.
 */
export function buildCaptureHtml(capture, { ignoreHeadInlineStyles = false } = {}) {
  if (!capture.sheets) return { html: capture.html, css: null };

  const css = capture.sheets.map((s) => s.css).join('\n');
  const criticalInput = capture.sheets
    .filter((s) => !(ignoreHeadInlineStyles && s.inHead))
    .map((s) => s.css)
    .join('\n');
  // Escape a literal "</style" so captured CSS can't close the tag early.
  const styleTag = `<style>${criticalInput.replace(/<\/style/gi, '<\\/style')}</style>`;

  const html = /<head[^>]*>/i.test(capture.html)
    ? capture.html.replace(/<head[^>]*>/i, (head) => `${head}${styleTag}`)
    : `${styleTag}${capture.html}`;

  return { html, css };
}
