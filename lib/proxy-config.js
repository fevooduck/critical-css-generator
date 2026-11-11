import { config } from './app-config.js';

// Proxies are configured in the settings center (critical.config.json,
// "proxies": { hostname: "http://user:pass@host:port" }). A legacy
// proxies.json at the project root is still read when the config has none.
export async function getProxyForDomain(hostname) {
  return config.proxies[hostname] || null;
}
