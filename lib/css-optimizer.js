import zlib from 'zlib';
import postcss from 'postcss';
import cssnano from 'cssnano';
import combineSelectors from 'postcss-combine-duplicated-selectors';

// Hard ceiling based on TCP initial congestion window (10 TCP segments * 1460 bytes MSS)
export const TCP_INITCWND_CEILING_BYTES = 14600; // ~14.25 KB (14.6 KB)
// Ideal ceiling leaving 4-6KB for initial HTML markup + HTTP response headers within the same 1st RTT
export const IDEAL_CRITICAL_GZIP_BYTES = 10240; // 10 KB

/**
 * Calculates the exact Gzip compressed byte size of a string or buffer.
 * @param {string|Buffer} content
 * @returns {number}
 */
export function getGzipSize(content) {
  if (!content) return 0;
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  if (buffer.length === 0) return 0;
  return zlib.gzipSync(buffer, { level: 9 }).length;
}

/**
 * Returns byte size (raw) of a string.
 * @param {string} content
 * @returns {number}
 */
export function getRawSize(content) {
  if (!content) return 0;
  return Buffer.byteLength(content, 'utf-8');
}

/**
 * Evaluates CSS against Web Performance TCP budget standards.
 * @param {string} css
 * @param {number} [targetLimit=TCP_INITCWND_CEILING_BYTES]
 * @param {number} [idealLimit=IDEAL_CRITICAL_GZIP_BYTES]
 */
export function auditCssBudget(
  css,
  targetLimit = TCP_INITCWND_CEILING_BYTES,
  idealLimit = IDEAL_CRITICAL_GZIP_BYTES,
) {
  const rawBytes = getRawSize(css);
  const gzipBytes = getGzipSize(css);
  const percentOfTarget = targetLimit > 0 ? Math.round((gzipBytes / targetLimit) * 100) : 0;

  let status = 'optimal';
  let message = 'Excelente: cabe confortavelmente no 1º RTT junto com o HTML.';

  if (gzipBytes > targetLimit) {
    status = 'exceeded';
    message = `Excedido: ultrapassou o teto de ${(targetLimit / 1024).toFixed(1)}KB (${(gzipBytes / 1024).toFixed(1)}KB). Exigirá RTTs adicionais.`;
  } else if (gzipBytes > idealLimit) {
    status = 'warning';
    message = `Alerta: entre ${(idealLimit / 1024).toFixed(1)}KB e ${(targetLimit / 1024).toFixed(1)}KB. Risco de estourar 1º RTT se o HTML for pesado.`;
  }

  return {
    rawBytes,
    gzipBytes,
    rawFormatted: `${(rawBytes / 1024).toFixed(1)}KB`,
    gzipFormatted: `${(gzipBytes / 1024).toFixed(1)}KB`,
    targetLimit,
    idealLimit,
    percentOfTarget,
    status,
    message,
  };
}

/**
 * PostCSS plugin that trims non-critical declarations and rules:
 * 1. Interaction pseudo-classes (:hover, :active, :focus, :focus-within, :focus-visible) -
 *    not needed for the static initial visual paint (First Contentful Paint).
 * 2. Unreferenced CSS Variables in :root:
 *    Scans all var(--name) used in rules and prunes unused custom properties from :root.
 * 3. Removes oversized data URI backgrounds (e.g. inline SVGs/images > 300 chars)
 * 4. Removes @media print blocks.
 */
export const pruneNonCriticalPlugin = (opts = {}) => {
  const {
    removeInteractions = true,
    pruneCssVars = true,
    maxDataUriLength = 300,
    removePrint = true,
  } = opts;

  return {
    postcssPlugin: 'postcss-prune-non-critical',
    Once(root) {
      // 1. Remove @media print
      if (removePrint) {
        root.walkAtRules((atRule) => {
          if (atRule.name === 'media' && /print/i.test(atRule.params)) {
            atRule.remove();
          }
        });
      }

      // 2. Remove oversized data URIs or background SVG bloat
      if (maxDataUriLength > 0) {
        root.walkDecls((decl) => {
          if (/background(-image)?/i.test(decl.prop) && /data:(image|font)\//i.test(decl.value)) {
            if (decl.value.length > maxDataUriLength) {
              decl.remove();
            }
          }
        });
      }

      // 3. Remove interaction pseudo-selectors (:hover, :active, :focus, :focus-visible, :focus-within)
      if (removeInteractions) {
        root.walkRules((rule) => {
          // Skip if rule is inside @keyframes or already removed
          if (!rule.parent || rule.parent.type === 'atrule' && rule.parent.name === 'keyframes') {
            return;
          }

          const interactionRegex = /:(hover|active|focus|focus-visible|focus-within)\b/i;
          const selectors = rule.selectors || [rule.selector];
          const keptSelectors = selectors.filter((sel) => !interactionRegex.test(sel));

          if (keptSelectors.length === 0) {
            rule.remove();
          } else if (keptSelectors.length !== selectors.length) {
            rule.selectors = keptSelectors;
          }
        });
      }

      // 4. Tree-shake unused CSS Variables (:root { --var: ... })
      if (pruneCssVars) {
        const usedVars = new Set();
        const varUsageRegex = /var\(\s*(--[a-zA-Z0-9_-]+)/g;

        // Collect all var(--custom-prop) referenced anywhere in the sheet
        root.walkDecls((decl) => {
          if (decl.prop.startsWith('--')) return; // ignore definitions for now
          let match;
          while ((match = varUsageRegex.exec(decl.value)) !== null) {
            usedVars.add(match[1]);
          }
        });

        // Also check if any var() references another var() inside variable declarations
        let newlyFound = true;
        while (newlyFound) {
          newlyFound = false;
          root.walkDecls((decl) => {
            if (decl.prop.startsWith('--') && usedVars.has(decl.prop)) {
              let match;
              while ((match = varUsageRegex.exec(decl.value)) !== null) {
                if (!usedVars.has(match[1])) {
                  usedVars.add(match[1]);
                  newlyFound = true;
                }
              }
            }
          });
        }

        // Now remove all unused custom properties declared in :root, html, or body
        root.walkRules((rule) => {
          if (/^(:root|html|body)$/i.test(rule.selector.trim())) {
            rule.walkDecls((decl) => {
              if (decl.prop.startsWith('--') && !usedVars.has(decl.prop)) {
                decl.remove();
              }
            });
            // If the rule became empty, remove it
            if (rule.nodes && rule.nodes.length === 0) {
              rule.remove();
            }
          }
        });
      }
    },
  };
};
pruneNonCriticalPlugin.postcss = true;

export const CRITICAL_CASCADE_LAYER = 'critical';

/**
 * Wraps the critical CSS in a cascade layer. Layered rules always lose to the
 * page's own (unlayered) CSS, whatever their position in the document, so a
 * block placed after the full stylesheets can't re-assert a rule the page
 * overrides later (e.g. `.cta` beating `.cta--outline`). Before the full CSS
 * loads, the layer is all there is and applies normally. Supported by every
 * browser since 2022 (Chrome/Edge 99, Firefox 97, Safari 15.4).
 *
 * @param {string} css
 * @param {string} [name=CRITICAL_CASCADE_LAYER]
 * @returns {string}
 */
export function wrapInCascadeLayer(css, name = CRITICAL_CASCADE_LAYER) {
  // @charset (added by cssnano for non-ASCII content) is invalid inside a
  // block and meaningless in a <style> tag anyway.
  const body = (css || '').replace(/^\s*@charset\s+[^;]+;/i, '').trim();
  return body ? `@layer ${name}{${body}}` : '';
}

/**
 * Complete Critical CSS optimization and compression pipeline.
 *
 * @param {string} css - Raw critical CSS string
 * @param {object} [options]
 * @param {boolean} [options.aggressivePruning=true] - Remove interaction pseudos and unused vars
 * @param {boolean} [options.combineDuplicates=true] - Combine duplicated selectors
 * @param {string|null} [options.cascadeLayer='critical'] - Cascade layer to wrap the result in (null: none)
 * @returns {Promise<{ css: string, audit: ReturnType<typeof auditCssBudget> }>}
 */
export async function optimizeCriticalCSS(css, options = {}) {
  if (!css || typeof css !== 'string' || !css.trim()) {
    return {
      css: '',
      audit: auditCssBudget(''),
    };
  }

  const {
    aggressivePruning = true,
    combineDuplicates = true,
    targetLimit = TCP_INITCWND_CEILING_BYTES,
    idealLimit = IDEAL_CRITICAL_GZIP_BYTES,
    cascadeLayer = CRITICAL_CASCADE_LAYER,
  } = options;

  const finish = (output) =>
    cascadeLayer ? wrapInCascadeLayer(output, cascadeLayer) : output;

  const plugins = [];

  // Pass 1: Combine duplicated selectors & properties
  if (combineDuplicates) {
    plugins.push(combineSelectors({ removeDuplicatedProperties: true }));
  }

  // Pass 2: Prune non-critical rules and unused CSS variables
  if (aggressivePruning) {
    plugins.push(
      pruneNonCriticalPlugin({
        removeInteractions: true,
        pruneCssVars: true,
        maxDataUriLength: 300,
        removePrint: true,
      }),
    );
  }

  // Pass 3: Production CSS minification via cssnano
  plugins.push(
    cssnano({
      preset: [
        'default',
        {
          discardComments: { removeAll: true },
          discardDuplicates: true,
          mergeRules: true,
          normalizeWhitespace: true, // Minify all whitespace!
          minifySelectors: true,
          colormin: true,
          reduceInitial: true,
          svgo: true,
        },
      ],
    }),
  );

  try {
    const result = await postcss(plugins).process(css, { from: undefined });
    const finalCss = finish(result.css.trim());
    const audit = auditCssBudget(finalCss, targetLimit, idealLimit);

    return {
      css: finalCss,
      audit,
    };
  } catch (error) {
    console.warn('  ⚠️ Aviso ao otimizar CSS via PostCSS/cssnano:', error.message);
    const fallbackCss = finish(css);
    const audit = auditCssBudget(fallbackCss, targetLimit, idealLimit);
    return {
      css: fallbackCss,
      audit,
    };
  }
}
