import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Project-specific settings live in critical.config.json at the project root
// (never committed, see .gitignore). They are edited from the UI's settings
// center (GET/PUT /api/settings) or by hand; every key is optional and falls
// back to DEFAULTS. Point CRITICAL_CSS_CONFIG at another file to keep several
// setups side by side.

export const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_FILE = process.env.CRITICAL_CSS_CONFIG
  ? path.resolve(process.env.CRITICAL_CSS_CONFIG)
  : path.join(PROJECT_ROOT, 'critical.config.json');

// Older setups kept proxies in their own file; still read as a fallback.
const LEGACY_PROXIES_FILE = path.join(PROJECT_ROOT, 'proxies.json');

export const DEFAULTS = Object.freeze({
  // Substrings of stylesheet URLs never fed to critical CSS generation
  // (icon/sprite libraries, print sheets, third-party widgets).
  ignoredStylesheets: ['print.css'],
  // Regular expressions (case-insensitive) tested against every selector of
  // the generated critical CSS; matching selectors are dropped.
  ignoredSelectorPatterns: [],
  // Elements removed from the snapshot (and their rules from the output)
  // when a request doesn't send its own `excludedSelectors`.
  defaultExcludedSelectors: ['.modal', '#onetrust-banner-sdk', '.dropdown-content'],
  // Accept-Language sent with every page visit (empty = browser default).
  acceptLanguage: 'en-US,en;q=0.9',
  // Example URL shown in the UI's URL field.
  urlPlaceholder: 'https://www.example.com/',
  // hostname -> proxy URL ("http://user:pass@host:port"), tried when the
  // direct visit is blocked.
  proxies: {},
  browser: Object.freeze({
    // Playwright channel for page visits: empty uses the headless shell that
    // critical renders with too (one browser download). "chromium" or
    // "chrome" need `npx playwright install chromium` / an installed Chrome.
    channel: '',
    launchArgs: [],
  }),
  // Optional ES module with browser hooks (see README, "Browser hooks"),
  // relative to the project root. Missing file = no hooks.
  hooksFile: 'local/browser-hooks.js',
});

function asStringArray(value, key) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`"${key}" deve ser uma lista de textos`);
  }
  return value.map((v) => v.trim()).filter(Boolean);
}

function compilePatterns(sources) {
  return sources.map((source) => {
    try {
      return new RegExp(source, 'i');
    } catch (error) {
      throw new Error(`"ignoredSelectorPatterns": RegExp inválida "${source}" (${error.message})`);
    }
  });
}

function asProxyMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('"proxies" deve ser um objeto { hostname: url }');
  }
  for (const [host, url] of Object.entries(value)) {
    try {
      new URL(url);
    } catch {
      throw new Error(`"proxies": URL inválida para ${host}`);
    }
  }
  return { ...value };
}

// Raw values (what's stored in the file) merged over the defaults.
function mergeRaw(values = {}) {
  return {
    ...DEFAULTS,
    ...values,
    browser: { ...DEFAULTS.browser, ...(values.browser || {}) },
  };
}

// Validates raw values and derives the runtime config. Throws on bad input.
function compile(raw) {
  return Object.freeze({
    ignoredStylesheets: asStringArray(raw.ignoredStylesheets, 'ignoredStylesheets'),
    ignoredSelectorPatterns: compilePatterns(
      asStringArray(raw.ignoredSelectorPatterns, 'ignoredSelectorPatterns'),
    ),
    defaultExcludedSelectors: asStringArray(
      raw.defaultExcludedSelectors,
      'defaultExcludedSelectors',
    ),
    acceptLanguage: String(raw.acceptLanguage || '').trim(),
    urlPlaceholder: String(raw.urlPlaceholder || DEFAULTS.urlPlaceholder),
    proxies: Object.freeze(asProxyMap(raw.proxies)),
    browser: Object.freeze({
      channel: String(raw.browser.channel || '').trim() || undefined,
      launchArgs: asStringArray(raw.browser.launchArgs, 'browser.launchArgs'),
    }),
    hooksFile: raw.hooksFile ? path.resolve(PROJECT_ROOT, raw.hooksFile) : null,
  });
}

function readStoredValues() {
  let values = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      values = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (error) {
      throw new Error(`Arquivo de configuração inválido (${CONFIG_FILE}): ${error.message}`);
    }
  }
  if (!values.proxies && fs.existsSync(LEGACY_PROXIES_FILE)) {
    try {
      values.proxies = JSON.parse(fs.readFileSync(LEGACY_PROXIES_FILE, 'utf-8'));
    } catch {
      // unreadable legacy file: ignore
    }
  }
  return values;
}

let stored = readStoredValues();

// Live ESM binding: modules importing `config` see the new object after a
// save, so settings apply to the next visit without a restart.
export let config = compile(mergeRaw(stored));

if (fs.existsSync(CONFIG_FILE)) {
  console.log(`⚙️  Configuração carregada de ${path.relative(PROJECT_ROOT, CONFIG_FILE) || CONFIG_FILE}`);
}

function displayPath(file) {
  const relative = path.relative(PROJECT_ROOT, file);
  return relative && !relative.startsWith('..') ? relative : file;
}

const SECRET_MASK = '********';

function maskProxyUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = SECRET_MASK;
    return parsed.href;
  } catch {
    return url;
  }
}

// A masked password coming back from the UI means "unchanged".
function unmaskProxies(incoming, previous) {
  const out = {};
  for (const [host, url] of Object.entries(incoming || {})) {
    let value = String(url).trim();
    if (value.includes(SECRET_MASK) && previous[host]) {
      try {
        const next = new URL(value);
        next.password = new URL(previous[host]).password;
        value = next.href;
      } catch {
        // invalid URL: validation reports it
      }
    }
    out[host.trim()] = value;
  }
  return out;
}

/** Settings as shown in the UI (proxy passwords masked). */
export function getSettings() {
  const raw = mergeRaw(stored);
  return {
    file: displayPath(CONFIG_FILE),
    exists: fs.existsSync(CONFIG_FILE),
    values: {
      ...raw,
      proxies: Object.fromEntries(
        Object.entries(raw.proxies || {}).map(([host, url]) => [host, maskProxyUrl(url)]),
      ),
    },
    defaults: DEFAULTS,
  };
}

/**
 * Validates and stores new settings, then applies them.
 * @returns {Promise<{ browserChanged: boolean }>}
 */
export async function saveSettings(values) {
  const previousRaw = mergeRaw(stored);
  const nextStored = {
    ...values,
    proxies: unmaskProxies(values.proxies, previousRaw.proxies || {}),
  };
  const nextRaw = mergeRaw(nextStored);
  const nextConfig = compile(nextRaw); // throws on invalid input

  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(nextStored, null, 2)}\n`);
  await fsp.rename(tmp, CONFIG_FILE);

  const browserChanged =
    JSON.stringify(previousRaw.browser) !== JSON.stringify(nextRaw.browser) ||
    previousRaw.hooksFile !== nextRaw.hooksFile ||
    previousRaw.acceptLanguage !== nextRaw.acceptLanguage;

  stored = nextStored;
  config = nextConfig;
  if (browserChanged) hooksPromise = null;
  return { browserChanged };
}

let hooksPromise = null;

/**
 * Browser hooks module (all exports optional):
 *   launchArgs: string[]                        extra Chromium flags
 *   contextOptions(browserVersion): object      merged into every newContext()
 *   setupPage(page, { context }): Promise       before navigation
 *   afterNavigation(page, { context }): Promise right after page.goto()
 *
 * @returns {Promise<object>}
 */
export function loadBrowserHooks() {
  if (!hooksPromise) {
    hooksPromise = (async () => {
      const file = config.hooksFile;
      if (!file || !fs.existsSync(file)) return {};
      // Query string busts the ESM cache when the hooks are reloaded.
      const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      console.log(`🪝 Browser hooks carregados de ${path.relative(PROJECT_ROOT, file)}`);
      return mod.default && typeof mod.default === 'object' ? mod.default : mod;
    })();
  }
  return hooksPromise;
}
