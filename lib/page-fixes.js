// Correções de CLS que dependem de scripts de terceiros presentes na página.
//
// O crítico só enxerga o CSS da página; certos scripts mexem no layout depois
// da primeira pintura de um jeito previsível. Cada correção aqui só entra no
// crítico quando a página capturada usa aquele script, então mercados sem ele
// não carregam regra nenhuma a mais.
//
// Rodam depois do filtro de seletores ignorados (buildCssIgnoreRules), que
// descarta as regras do OneTrust: as daqui sobrevivem a ele de propósito.

// Padding que o GPT aplica inline no <body> para o TOP_ANCHOR (anúncio de
// 130px + aba de fechar). Usado quando a captura não chegou a ver o anúncio.
const GPT_TOP_ANCHOR_PADDING_PX = 155;

/**
 * Anúncio âncora do topo do Google Publisher Tag
 * (`OutOfPageFormat.TOP_ANCHOR`). Ao preencher, o GPT aplica
 * `padding-top:155px` inline no <body> e empurra a página inteira (CLS ~0.19).
 * Reservar esse espaço desde a primeira pintura tira o shift; o GPT ainda rola
 * a janela pelos mesmos 155px depois, então o resultado visual é o mesmo de
 * antes. `!important` porque o GPT também zera o padding inline (`padding:0`)
 * antes de preencher, e isso desfaria a reserva.
 *
 * O breakpoint vem da própria condição do site
 * (`document.body.clientWidth <= 500 ? TOP_ANCHOR : BOTTOM_ANCHOR`).
 */
function gptTopAnchor(html) {
  const at = html.search(/OutOfPageFormat\.TOP_ANCHOR/);
  if (at === -1) return null;

  const around = html.slice(Math.max(0, at - 200), at + 30);
  const breakpoint = around.match(
    /(?:clientWidth|innerWidth)\s*(<=|<)\s*(\d+)\s*\?\s*(?:[\w$]+\.)*TOP_ANCHOR/,
  );
  const isConditional = /\?\s*(?:[\w$]+\.)*TOP_ANCHOR|TOP_ANCHOR\s*:/.test(around);

  // TOP_ANCHOR só em parte dos viewports, numa condição que não sabemos ler:
  // melhor não reservar espaço do que reservar no viewport errado.
  if (isConditional && !breakpoint) {
    return {
      id: 'gpt-top-anchor',
      label: 'GPT TOP_ANCHOR detectado, mas a condição de viewport não foi reconhecida — padding não reservado',
      css: '',
    };
  }

  // Se o anúncio preencheu durante a captura, o padding inline real está no
  // snapshot; senão usa o padrão medido.
  const captured = html.match(
    /<body\b[^>]*\bstyle="[^"]*padding(?:-top)?:\s*(\d+)px/i,
  );
  const padding = captured && +captured[1] > 0 ? +captured[1] : GPT_TOP_ANCHOR_PADDING_PX;

  const rule = `body{padding-top:${padding}px!important}`;
  if (!breakpoint) {
    return { id: 'gpt-top-anchor', label: `GPT TOP_ANCHOR: reserva ${padding}px no topo`, css: rule };
  }

  const max = breakpoint[1] === '<' ? +breakpoint[2] - 1 : +breakpoint[2];
  return {
    id: 'gpt-top-anchor',
    label: `GPT TOP_ANCHOR: reserva ${padding}px no topo até ${max}px de largura`,
    css: `@media (max-width:${max}px){${rule}}`,
  };
}

/**
 * Banner de cookies do OneTrust com entrada "slide in": o SDK posiciona o
 * banner fora da tela (`bottom:-99px` no otFlat, `-300px` nos flutuantes) e
 * anima o `bottom` inline até a posição final em 1–2s. Cada quadro da animação
 * de um elemento fixo conta como layout shift (~0.05 somados). Fixar a posição
 * final faz o banner simplesmente aparecer no lugar. Os valores são os mesmos
 * que o SDK grava ao fim da animação (otBannerSdk.js, slideInAnimation).
 * Banner no topo (`.top`) fica de fora: no modo "push down" o SDK posiciona
 * por conta própria.
 */
function oneTrustBanner(html) {
  if (!/otSDKStub|cookielaw\.org|onetrust-banner-sdk/i.test(html)) return null;
  return {
    id: 'onetrust-banner',
    label: 'OneTrust: banner de cookies sem animação de entrada',
    css:
      '#onetrust-banner-sdk.otFlat:not(.top){bottom:0!important}' +
      '#onetrust-banner-sdk.otFloatingRoundedCorner,#onetrust-banner-sdk.otFloatingRounded{bottom:1rem!important}',
  };
}

const DETECTORS = [gptTopAnchor, oneTrustBanner];

/**
 * Detecta, no HTML capturado (com os scripts inline), quais correções se
 * aplicam a esta página.
 *
 * @param {string} html
 * @returns {Array<{ id: string, label: string, css: string }>}
 */
export function detectPageFixes(html) {
  if (!html || typeof html !== 'string') return [];
  return DETECTORS.map((detect) => detect(html)).filter(Boolean);
}

/**
 * @param {string} css - Crítico já filtrado
 * @param {Array<{ css: string }>} fixes - Resultado de detectPageFixes
 * @returns {string}
 */
export function appendPageFixes(css, fixes = []) {
  const extra = fixes.map((f) => f.css).filter(Boolean).join('\n');
  return extra ? `${css}\n${extra}` : css;
}
