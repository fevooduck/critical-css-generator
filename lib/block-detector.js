// Heuristics to recognize a WAF/bot-protection challenge or block page
// (Akamai Bot Manager and a few other common CDNs/WAFs) instead of the
// real page content, so a batch job can fail fast with a clear reason
// instead of silently generating critical CSS from an error page.

const SIGNALS = [
  { provider: 'akamai', pattern: /reference #\d/i, label: 'texto "Reference #" (página de bloqueio Akamai)' },
  { provider: 'akamai', pattern: /akamaighost/i, label: 'marcador "AkamaiGHost"' },
  { provider: 'akamai', pattern: /pardon our interruption/i, label: 'texto "Pardon Our Interruption" (challenge Akamai)' },
  { provider: 'akamai', pattern: /access denied/i, label: 'texto "Access Denied"' },
  { provider: 'akamai', pattern: /you don't have permission to access/i, label: 'texto "you don\'t have permission to access"' },
  { provider: 'cloudflare', pattern: /just a moment\.\.\./i, label: 'título "Just a moment..." (challenge Cloudflare)' },
  { provider: 'cloudflare', pattern: /attention required!? \| cloudflare/i, label: 'título "Attention Required! | Cloudflare"' },
  { provider: 'cloudflare', pattern: /checking your browser before accessing/i, label: 'texto "Checking your browser before accessing"' },
  { provider: 'cloudflare', pattern: /__cf_chl_/i, label: 'script de challenge Cloudflare (__cf_chl_)' },
  { provider: 'incapsula', pattern: /request unsuccessful\. incapsula incident id/i, label: 'texto "Incapsula incident ID"' },
];

const BLOCKABLE_STATUS_CODES = new Set([401, 403, 406, 429, 503, 1020]);

/**
 * @param {{status?: number, headers?: Record<string,string>, html?: string, title?: string}} input
 */
export function detectBlock({ status = 0, headers = {}, html = '', title = '' }) {
  const haystack = `${title}\n${html.slice(0, 5000)}`;
  const serverHeader = headers?.server || headers?.Server || '';

  const matched = [];
  let provider = null;

  for (const signal of SIGNALS) {
    if (signal.pattern.test(haystack) || signal.pattern.test(serverHeader)) {
      matched.push(signal.label);
      provider = provider || signal.provider;
    }
  }

  if (matched.length > 0) {
    return {
      blocked: true,
      confidence: 'high',
      provider,
      reason: `Bloqueio detectado (${provider}): ${matched[0]}`,
      matchedSignals: matched,
      status,
    };
  }

  const isSuspiciousStatus = BLOCKABLE_STATUS_CODES.has(status);
  const isSuspiciouslyEmpty = html.trim().length > 0 && html.trim().length < 800;

  if (isSuspiciousStatus) {
    // Custom error pages (e.g. a branded "This site is temporarily unavailable")
    // carry none of the text signals above, but Akamai still stamps its headers.
    const isAkamai = Object.keys(headers || {}).some((name) =>
      /^(akamai-grn|x-akamai-)/i.test(name),
    );
    const providerName = isAkamai ? 'akamai' : 'unknown';
    return {
      blocked: true,
      confidence: isSuspiciouslyEmpty || isAkamai ? 'high' : 'medium',
      provider: providerName,
      reason: `Resposta HTTP ${status}, compatível com bloqueio por WAF/anti-bot${isAkamai ? ' (Akamai)' : ''}`,
      matchedSignals: [`http_status_${status}`],
      status,
    };
  }

  return {
    blocked: false,
    confidence: null,
    provider: null,
    reason: null,
    matchedSignals: [],
    status,
  };
}
