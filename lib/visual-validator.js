import {
  getSharedContext,
  preparePageWithHooks,
  GENERATED_BLOCK_MEDIA,
} from './browser-manager.js';
import { detectBlock } from './block-detector.js';

// Visual validation of a generated critical CSS block against the live page.
// It injects the real generated block and compares computed styles element
// by element, filtering page noise with two baseline snapshots.
//
// Test A (first paint): external stylesheets disabled, only inline <style>
//   tags + the critical block apply. Differences in the first fold are what
//   the user sees before the full CSS arrives (FOUC / layout shift).
// Test B (after full load): full CSS + the block at each candidate position.
//   Any difference means the block changes the final cascade, i.e. it breaks
//   the page in production for as long as it stays in the DOM.

export const BLOCK_POSITIONS = {
  'head-start': 'Início do <head>',
  'head-end': 'Fim do <head>',
  'body-start': 'Início do <body> (região de bloco do Drupal)',
};

export const DEFAULT_VIEWPORTS = [
  { name: 'mobile', width: 393, height: 852 },
  { name: 'desktop', width: 1920, height: 1080 },
];

const PROPS = [
  'background-color', 'background-image', 'color', 'filter', 'display', 'visibility', 'opacity',
  'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'font-size', 'font-weight', 'font-family', 'line-height', 'text-align', 'text-decoration-line',
  'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color',
  'border-top-width', 'border-bottom-width', 'border-radius',
  'width', 'max-width', 'height', 'min-height',
  'flex-direction', 'justify-content', 'align-items', 'gap', 'position', 'top', 'z-index',
  'fill', 'stroke', 'box-shadow', 'object-fit',
];
const PSEUDO_PROPS = ['background-color', 'background-image', 'color', 'filter', 'display', 'width', 'height'];

// Properties whose change moves or resizes boxes (layout shift), as opposed
// to purely visual ones (colors, shadows...).
const LAYOUT_PROPS = new Set([
  'display', 'position', 'top', 'width', 'max-width', 'height', 'min-height',
  'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'font-size', 'font-weight', 'font-family', 'line-height',
  'border-top-width', 'border-bottom-width',
  'flex-direction', 'justify-content', 'align-items', 'gap',
  '::beforedisplay', '::afterdisplay', '::beforewidth', '::afterwidth', '::beforeheight', '::afterheight',
]);

const SETTLE_MS = 2000;
const NOISE_GAP_MS = 1500;
const MOVE_THRESHOLD_PX = 2;
const PIXEL_DIFF_THRESHOLD = 48; // sum of |dR|+|dG|+|dB| per pixel
const MAX_GROUPS = 40;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeMedia = (media) => (media || '').replace(/\s+/g, '').toLowerCase();

// Computed values that differ only in spelling, not in rendering: cssnano
// drops a gradient's implicit stop positions (`rgba(...) 0px, ... 100%)` ==
// `rgba(...), ...)`) and subpixel layout yields 353.7px vs 353.688px.
const COLOR = '(?:rgba?\\([^)]*\\)|#[0-9a-f]+|[a-z]+)';
const FIRST_STOP = new RegExp(
  `(gradient\\((?:[^,()]*?(?:deg|turn|rad)\\s*,\\s*|to [a-z ]+,\\s*)?${COLOR})\\s+0(?:px|%)?(?=\\s*,)`,
  'gi',
);
const LAST_STOP = new RegExp(`(${COLOR})\\s+100%(?=\\s*\\))`, 'gi');

function canonical(value) {
  if (!value.includes('gradient(')) return value;
  return value.replace(FIRST_STOP, '$1').replace(LAST_STOP, '$1');
}

function sameValue(a, b) {
  if (a === b) return true;
  // Pseudo-element props are only captured while it has content, so one side
  // is missing when a ::before/::after appears or disappears.
  if (a === undefined || b === undefined) return false;
  const pa = /^(-?[\d.]+)px$/.exec(a);
  const pb = /^(-?[\d.]+)px$/.exec(b);
  if (pa && pb) return Math.abs(parseFloat(pa[1]) - parseFloat(pb[1])) < 0.5;
  return canonical(a) === canonical(b);
}

// Stamps every element once so snapshots can be matched by identity even
// after a <style> is inserted at the top of <body> (which would shift any
// index-based matching), disables animations, and removes critical blocks
// left by a previous run so the baseline is the page without any.
async function preparePage(page) {
  return page.evaluate((generatedMedia) => {
    const style = document.createElement('style');
    style.setAttribute('data-ccv', 'freeze');
    style.textContent =
      '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}';
    document.head.appendChild(style);

    let removedOldBlocks = 0;
    document.querySelectorAll('style[media]').forEach((el) => {
      const media = el.getAttribute('media').replace(/\s+/g, '').toLowerCase();
      if (generatedMedia.includes(media)) {
        el.remove();
        removedOldBlocks++;
      }
    });

    let id = 0;
    document.querySelectorAll('body *').forEach((el) => {
      el.setAttribute('data-ccv-id', String(id++));
    });
    window.scrollTo(0, 0);
    return { removedOldBlocks, elementCount: id };
  }, GENERATED_BLOCK_MEDIA.map(normalizeMedia));
}

function snapshot(page) {
  return page.evaluate(
    ([props, pseudoProps]) => {
      window.scrollTo(0, 0);
      const vh = window.innerHeight;
      const out = [];
      document.querySelectorAll('body [data-ccv-id]').forEach((el) => {
        if (el.closest('#onetrust-consent-sdk, script, style, noscript, iframe, [data-aos]')) return;
        const cs = getComputedStyle(el);
        const r = {};
        for (const p of props) r[p] = cs.getPropertyValue(p);
        for (const pseudo of ['::before', '::after']) {
          const ps = getComputedStyle(el, pseudo);
          if (ps.content && ps.content !== 'none') {
            for (const p of pseudoProps) r[pseudo + p] = ps.getPropertyValue(p);
          }
        }
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden';
        const path = [];
        let n = el;
        while (n && n !== document.body && path.length < 4) {
          path.unshift(n.tagName.toLowerCase() + (n.classList.length ? '.' + [...n.classList].slice(0, 6).join('.') : ''));
          n = n.parentElement;
        }
        out.push({
          id: el.getAttribute('data-ccv-id'),
          path: path.join(' > '),
          r,
          rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
          inFold: visible && rect.top < vh && rect.bottom > 0,
          // Boxes continuing past the fold grow/shrink with below-the-fold
          // content, which is unstyled at first paint by design.
          crossesFold: visible && rect.top < vh && rect.bottom > vh,
        });
      });
      return out;
    },
    [PROPS, PSEUDO_PROPS],
  );
}

const HEIGHT_PROPS = new Set(['height', 'min-height']);

// `control` is a snapshot taken after the block was removed again: a
// difference only counts if the page returns to the baseline value without
// the block. Anything else changed on its own (carousel autoplay, lazy
// widgets) and is noise the pre-measured noise set did not catch.
function diffSnapshots(a, b, { noise, control, foldOnly = false } = {}) {
  const byId = new Map(b.map((x) => [x.id, x]));
  const controlById = control ? new Map(control.map((x) => [x.id, x])) : null;
  const diffs = [];
  const moved = [];
  for (const x of a) {
    const y = byId.get(x.id);
    if (!y) continue;
    if (foldOnly && !x.inFold && !y.inFold) continue;
    const c = controlById?.get(x.id);
    const spansFold = foldOnly && x.crossesFold && y.crossesFold;
    for (const k of Object.keys(x.r)) {
      if (sameValue(x.r[k], y.r[k]) || noise.has(`${x.id}|${k}`)) continue;
      if (controlById && (!c || !sameValue(x.r[k], c.r[k]))) continue;
      if (spansFold && HEIGHT_PROPS.has(k)) continue;
      diffs.push({ id: x.id, path: x.path, prop: k, before: x.r[k], after: y.r[k] });
    }
    if (foldOnly && !noise.has(`${x.id}|rect`)) {
      // x, y, width (and height, unless the box continues past the fold)
      const indexes = spansFold ? [0, 1, 2] : [0, 1, 2, 3];
      const changed = indexes.some((i) => Math.abs(x.rect[i] - y.rect[i]) > MOVE_THRESHOLD_PX);
      const settledBack =
        !controlById || (c && indexes.every((i) => Math.abs(x.rect[i] - c.rect[i]) <= MOVE_THRESHOLD_PX));
      if (changed && settledBack) {
        moved.push({ id: x.id, path: x.path, before: x.rect, after: y.rect });
      }
    }
  }
  return { diffs, moved };
}

function noiseSet(a1, a2) {
  const noise = new Set();
  const byId = new Map(a2.map((x) => [x.id, x]));
  for (const x of a1) {
    const y = byId.get(x.id);
    if (!y) continue;
    for (const k of Object.keys(x.r)) if (!sameValue(x.r[k], y.r[k])) noise.add(`${x.id}|${k}`);
    if (x.rect.some((v, i) => v !== y.rect[i])) noise.add(`${x.id}|rect`);
  }
  return noise;
}

// Backgrounds dropped on purpose by the generator (SVG and large data URIs
// load with the full CSS) are expected first-paint differences, not bugs.
function classify(diff) {
  if (/background-image$/.test(diff.prop) && diff.after === 'none') return 'expected';
  return LAYOUT_PROPS.has(diff.prop) ? 'layout' : 'visual';
}

function summarize(diffs) {
  const groups = new Map();
  for (const d of diffs) {
    const leaf = d.path.split(' > ').pop();
    const key = `${leaf}|${d.prop}|${d.before}|${d.after}`;
    const group = groups.get(key) || {
      element: leaf,
      path: d.path,
      prop: d.prop,
      before: d.before,
      after: d.after,
      kind: classify(d),
      count: 0,
    };
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, MAX_GROUPS);
}

async function injectBlock(page, blockHtml, position) {
  await page.evaluate(
    ([html, pos]) => {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      const styles = [...tpl.content.querySelectorAll('style')];
      const parent = pos.startsWith('head') ? document.head : document.body;
      const anchor = pos.endsWith('start') ? parent.firstChild : null;
      for (const s of styles) {
        s.setAttribute('data-ccv', 'critical');
        parent.insertBefore(s, anchor);
      }
    },
    [blockHtml, position],
  );
  await settle(page);
}

async function removeBlock(page) {
  await page.evaluate(() => {
    document.querySelectorAll('style[data-ccv="critical"]').forEach((el) => el.remove());
  });
  await settle(page);
}

// First paint: only inline <style> (and the critical block) apply. Keeps the
// same DOM (so element matching stays exact) instead of reloading the page
// with stylesheets blocked.
async function setExternalSheetsEnabled(page, enabled) {
  await page.evaluate((on) => {
    document.querySelectorAll('link[rel~="stylesheet"]').forEach((link) => {
      if (link.sheet) link.sheet.disabled = !on;
    });
  }, enabled);
  await settle(page);
}

async function settle(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await wait(300);
}

async function screenshot(page) {
  return (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');
}

// Pixel diff computed in a blank page's canvas, so no image library is needed.
async function pixelDiff(context, baseB64, otherB64) {
  const page = await context.newPage();
  try {
    return await page.evaluate(
      async ([a, b, threshold]) => {
        const load = (src) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = `data:image/jpeg;base64,${src}`;
          });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const w = Math.min(ia.width, ib.width);
        const h = Math.min(ia.height, ib.height);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(ia, 0, 0);
        const da = ctx.getImageData(0, 0, w, h);
        ctx.drawImage(ib, 0, 0);
        const db = ctx.getImageData(0, 0, w, h);
        const out = ctx.createImageData(w, h);
        let changed = 0;
        for (let i = 0; i < da.data.length; i += 4) {
          const delta =
            Math.abs(da.data[i] - db.data[i]) +
            Math.abs(da.data[i + 1] - db.data[i + 1]) +
            Math.abs(da.data[i + 2] - db.data[i + 2]);
          if (delta > threshold) {
            changed++;
            out.data[i] = 230;
            out.data[i + 1] = 30;
            out.data[i + 2] = 60;
            out.data[i + 3] = 255;
          } else {
            const gray = (da.data[i] + da.data[i + 1] + da.data[i + 2]) / 3;
            const faded = 255 - (255 - gray) * 0.25;
            out.data[i] = out.data[i + 1] = out.data[i + 2] = faded;
            out.data[i + 3] = 255;
          }
        }
        ctx.putImageData(out, 0, 0);
        return {
          percent: Math.round((changed / (w * h)) * 10000) / 100,
          image: canvas.toDataURL('image/jpeg', 0.7).split(',')[1],
        };
      },
      [baseB64, otherB64, PIXEL_DIFF_THRESHOLD],
    );
  } finally {
    await page.close().catch(() => {});
  }
}

async function validateViewport(context, url, blockHtml, viewport, productionPosition, onStep) {
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await preparePageWithHooks(page, context);

    onStep(`Carregando a página (${viewport.name})`);
    let response = null;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: 90000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    } catch (error) {
      // networkidle may never come (long-polling, chat widgets): validate
      // whatever rendered, unless nothing did.
      if (!(await page.$('body *'))) throw error;
    }
    const [html, title] = await Promise.all([page.content(), page.title()]);
    const block = detectBlock({
      status: response ? response.status() : 0,
      headers: response ? response.headers() : {},
      html,
      title,
    });
    if (block.blocked) {
      throw new Error(`${block.reason}. Valide por um ambiente sem WAF (homologação/staging).`);
    }

    await wait(SETTLE_MS);
    const { removedOldBlocks, elementCount } = await preparePage(page);
    await settle(page);

    onStep(`Medindo ruído da página (${viewport.name})`);
    const a1 = await snapshot(page);
    await wait(NOISE_GAP_MS);
    const baseline = await snapshot(page);
    const noise = noiseSet(a1, baseline);
    const baselineShot = await screenshot(page);

    // Test B — final cascade with the block at each candidate position
    const finalCascade = {};
    for (const position of Object.keys(BLOCK_POSITIONS)) {
      onStep(`Teste B: bloco em "${BLOCK_POSITIONS[position]}" (${viewport.name})`);
      await injectBlock(page, blockHtml, position);
      const withBlock = await snapshot(page);
      await removeBlock(page);
      const control = await snapshot(page);
      const { diffs } = diffSnapshots(baseline, withBlock, { noise, control });
      finalCascade[position] = { diffCount: diffs.length, groups: summarize(diffs) };
    }

    // Test A — first paint with only the critical block
    onStep(`Teste A: primeira pintura só com o CSS crítico (${viewport.name})`);
    await injectBlock(page, blockHtml, productionPosition);
    await setExternalSheetsEnabled(page, false);
    const firstPaint = await snapshot(page);
    const firstPaintShot = await screenshot(page);
    await setExternalSheetsEnabled(page, true);
    await removeBlock(page);
    const control = await snapshot(page);

    const { diffs, moved } = diffSnapshots(baseline, firstPaint, {
      noise,
      control,
      foldOnly: true,
    });
    const counts = { layout: 0, visual: 0, expected: 0 };
    for (const d of diffs) counts[classify(d)]++;
    const pixel = await pixelDiff(context, baselineShot, firstPaintShot);

    const breaks = finalCascade[productionPosition].diffCount > 0;
    const verdict = breaks
      ? 'breaks'
      : counts.layout > 0 || moved.length > 0
        ? 'shift'
        : counts.visual > 0
          ? 'visual'
          : 'ok';

    return {
      viewport,
      verdict,
      removedOldBlocks,
      elementCount,
      noiseCount: noise.size,
      finalCascade,
      firstPaint: {
        diffCount: diffs.length,
        counts,
        movedCount: moved.length,
        moved: moved.slice(0, MAX_GROUPS),
        groups: summarize(diffs.filter((d) => classify(d) !== 'expected')),
        pixelDiff: pixel,
      },
      screenshots: {
        original: baselineShot,
        firstPaint: firstPaintShot,
        diff: pixel.image,
      },
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.blockHtml - the Drupal block as copied from the UI
 * @param {keyof BLOCK_POSITIONS} [params.position='body-start'] - where the block sits in production
 * @param {Array<{name: string, width: number, height: number}>} [params.viewports]
 * @param {(step: string) => void} [params.onStep]
 */
export async function validateCriticalBlock({
  url,
  blockHtml,
  position = 'body-start',
  viewports = DEFAULT_VIEWPORTS,
  onStep = () => {},
}) {
  const context = await getSharedContext();
  const results = [];
  for (const viewport of viewports) {
    try {
      results.push(
        await validateViewport(context, url, blockHtml, viewport, position, onStep),
      );
    } catch (error) {
      results.push({ viewport, verdict: 'error', error: error.message });
    }
  }
  return { url, position, results };
}
