const queues = new Map();

// Serializes calls sharing the same key (hostname) so a batch never hits the
// same WAF-protected domain twice at once, while different hostnames still
// run fully in parallel. Hitting a domain repeatedly in parallel is itself a
// common trigger for rate-based bot rules.
export function runExclusive(key, fn) {
  const tail = queues.get(key) || Promise.resolve();
  const result = tail.then(fn, fn);
  queues.set(
    key,
    result.then(
      () => {},
      () => {},
    ),
  );
  return result;
}
