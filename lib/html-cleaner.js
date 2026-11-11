import * as cheerio from 'cheerio';
import postcss from 'postcss';
import { config } from './app-config.js';

/**
 * Remove elementos do HTML baseado nos seletores CSS especificados
 * antes da extração do CSS crítico.
 * 
 * @param {string} html - HTML renderizado da página
 * @param {string[]} selectors - Lista de seletores CSS para excluir (ex: ['header', '#header', '.modal'])
 * @returns {{ html: string, removedCount: number, removedDetails: Array<{selector: string, count: number}> }}
 */
export function removeExcludedElements(html, selectors = []) {
  if (!html || typeof html !== 'string') {
    return { html: html || '', removedCount: 0, removedDetails: [] };
  }

  if (!Array.isArray(selectors) || selectors.length === 0) {
    return { html, removedCount: 0, removedDetails: [] };
  }

  const validSelectors = selectors
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);

  if (validSelectors.length === 0) {
    return { html, removedCount: 0, removedDetails: [] };
  }

  try {
    const $ = cheerio.load(html, { decodeEntities: false });
    let totalRemoved = 0;
    const removedDetails = [];

    for (const selector of validSelectors) {
      try {
        const matches = $(selector);
        const count = matches.length;
        if (count > 0) {
          totalRemoved += count;
          matches.remove();
          removedDetails.push({ selector, count });
        }
      } catch (err) {
        console.warn(
          `  ⚠️ Seletor inválido para exclusão do HTML ("${selector}"):`,
          err.message,
        );
      }
    }

    if (totalRemoved > 0) {
      return { html: $.html(), removedCount: totalRemoved, removedDetails };
    }

    return { html, removedCount: 0, removedDetails: [] };
  } catch (error) {
    console.error('  ⚠️ Erro ao processar HTML com Cheerio:', error.message);
    return { html, removedCount: 0, removedDetails: [] };
  }
}

// CSS que o OneTrust injeta em runtime (<style id="onetrust-style">) junto com
// o banner/central de preferências. Esses elementos não existem na primeira
// pintura e o OneTrust traz o próprio CSS quando os cria, então no crítico são
// só bytes (~100 classes `ot-*`). O que precisa estar no crítico para o banner
// não gerar CLS vem de lib/page-fixes.js.
const ONETRUST_SELECTOR =
  /#onetrust-|\.onetrust-|#ot-|\.ot-|\.otFlat|\.otPc|\.otFloating|\.otCenter/;

/**
 * Converte a lista de seletores excluídos em RegExp para filtrar o CSS crítico
 * gerado (ver filterCssByExcludedRules).
 *
 * @param {string[]} selectors - Lista de seletores CSS
 * @returns {RegExp[]}
 */
export function buildCssIgnoreRules(selectors = []) {
  // Project-wide patterns come from the settings center
  // ("ignoredSelectorPatterns" in critical.config.json).
  const baseRules = [...config.ignoredSelectorPatterns, ONETRUST_SELECTOR];

  if (!Array.isArray(selectors)) return baseRules;

  for (const s of selectors) {
    if (!s || typeof s !== 'string') continue;
    const trimmed = s.trim();
    if (!trimmed) continue;

    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (trimmed.startsWith('#')) {
      // ID: ex: #header -> casa com #header, #header > ..., #header-container, etc.
      baseRules.push(new RegExp(escaped + '([-\\w\\s>+~,.:#\\[]|$)', 'i'));
    } else if (trimmed.startsWith('.')) {
      // Classe: ex: .modal -> casa com .modal, .modal-dialog, .modal__box, etc.
      baseRules.push(new RegExp(escaped + '([-\\w\\s>+~,.:#\\[]|$)', 'i'));
    } else if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      // Tag HTML pura: ex: header -> casa com header, header > ..., header.classe, etc.
      baseRules.push(
        new RegExp('(^|[\\s>+~,])' + escaped + '([-\\w\\s>+~,.:#\\[]|$)', 'i'),
      );
    } else {
      // Seletor genérico complexo
      baseRules.push(new RegExp(escaped, 'i'));
    }
  }

  return baseRules;
}

/**
 * Filtra regras de CSS removendo qualquer regra cujo seletor pertença
 * aos seletores excluídos ou seus descendentes.
 * 
 * @param {string} css - String de CSS gerada
 * @param {RegExp[]} ignoreRules - Lista de RegExp de seletores a ignorar
 * @returns {string} - CSS filtrado
 */
export function filterCssByExcludedRules(css, ignoreRules = []) {
  if (!css || !Array.isArray(ignoreRules) || ignoreRules.length === 0) {
    return css;
  }

  try {
    const root = postcss.parse(css);

    root.walkRules((rule) => {
      const selectors = rule.selectors || [rule.selector];
      const kept = selectors.filter((sel) => {
        return !ignoreRules.some((regex) => regex.test(sel));
      });

      if (kept.length === 0) {
        rule.remove();
      } else if (kept.length !== selectors.length) {
        rule.selectors = kept;
      }
    });

    return root.toString();
  } catch (err) {
    console.warn(
      '  ⚠️ Aviso ao filtrar regras CSS residuais via PostCSS:',
      err.message,
    );
    return css;
  }
}
