import { visitUrl } from './browser-manager.js';
import { getProxyForDomain } from './proxy-config.js';
import { getCapture, buildCaptureHtml } from './manual-capture.js';
import { recordResult } from './domain-strategy.js';

const FRESH_RETRY_DELAY_MS = 1500;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Resolves a URL to renderable HTML through progressively more resilient
 * tiers, stopping at the first that works:
 *   1. direct visit with the shared browser
 *   2. direct visit again from a clean context (no persisted cookies), in
 *      case the profile carries a bot-manager cookie already flagged as bad
 *   3. a domain-dedicated proxy, if one is configured in the settings center
 *   4. a previously submitted manual capture (real browser, real session)
 * Records the outcome in the domain-strategy store either way, so the UI can
 * warn about domains that are known to need a proxy or manual capture.
 */
export async function resolvePage(url, opts = {}) {
  const hostname = hostnameOf(url);

  let attempt = await visitUrl(url, opts);
  if (!attempt.blockResult.blocked) {
    await recordResult(url, { blocked: false, strategy: 'direct' });
    return { ...attempt, strategy: 'direct' };
  }

  await delay(FRESH_RETRY_DELAY_MS);
  const freshAttempt = await visitUrl(url, { ...opts, freshContext: true });
  if (!freshAttempt.blockResult.blocked) {
    await recordResult(url, { blocked: false, strategy: 'direct-fresh' });
    return { ...freshAttempt, strategy: 'direct-fresh' };
  }
  attempt = freshAttempt;

  const proxyUrl = hostname ? await getProxyForDomain(hostname) : null;
  if (proxyUrl) {
    const proxyAttempt = await visitUrl(url, { ...opts, proxyUrl });
    if (!proxyAttempt.blockResult.blocked) {
      await recordResult(url, {
        blocked: false,
        strategy: 'proxy',
        provider: proxyAttempt.blockResult.provider,
      });
      return { ...proxyAttempt, strategy: 'proxy' };
    }
    attempt = proxyAttempt;
  }

  const capture = await getCapture(url);
  if (capture?.html) {
    console.log(
      `  📎 Automated access blocked; using the manual capture from ${capture.capturedAt}`,
    );
    const { html, css } = buildCaptureHtml(capture, opts);
    await recordResult(url, { blocked: false, strategy: 'manual-capture' });
    return {
      blockResult: {
        blocked: false,
        confidence: null,
        provider: null,
        reason: null,
        matchedSignals: [],
        status: 200,
      },
      html,
      css,
      strategy: 'manual-capture',
    };
  }

  await recordResult(url, {
    blocked: true,
    provider: attempt.blockResult.provider,
    strategy: null,
  });

  return { ...attempt, strategy: null };
}
