import { readJson, writeJson } from './json-store.js';

const FILE = 'domain-strategy.json';

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Remembers, per hostname, whether the last visit was blocked and which
// strategy last got through — so the UI can warn upfront ("this domain has
// been blocking direct access, try a proxy or manual capture") instead of
// the user rediscovering it by trial and error every batch.
export async function recordResult(url, { blocked, provider = null, strategy = null }) {
  const hostname = hostnameOf(url);
  if (!hostname) return;

  const store = await readJson(FILE, {});
  const previous = store[hostname];

  store[hostname] = {
    hostname,
    lastCheckedAt: new Date().toISOString(),
    blocked,
    provider: provider || previous?.provider || null,
    lastWorkingStrategy: blocked ? previous?.lastWorkingStrategy || null : strategy,
    consecutiveBlocks: blocked ? (previous?.consecutiveBlocks || 0) + 1 : 0,
  };

  await writeJson(FILE, store);
}

export async function getDomainInfo(url) {
  const hostname = hostnameOf(url);
  if (!hostname) return null;
  const store = await readJson(FILE, {});
  return store[hostname] || null;
}

export async function listDomains() {
  const store = await readJson(FILE, {});
  return Object.values(store);
}
