import "server-only";

/**
 * Per-instance sliding-window rate limiter keyed by IP (or anything else).
 * Stale keys are evicted as the map is used, and the map never holds more than `maxKeys`
 * entries, so it can't grow without bound. Serverless instances don't share it: this is a
 * speed bump, not a guarantee.
 */
export function rateLimiter({ windowMs, max, maxKeys = 5_000 }: { windowMs: number; max: number; maxKeys?: number }) {
  const hits = new Map<string, number[]>();
  let lastSweep = 0;

  const sweep = (now: number) => {
    for (const [k, times] of hits) {
      if (!times.length || now - times[times.length - 1] >= windowMs) hits.delete(k);
    }
    lastSweep = now;
  };

  /** Records a hit for `key` and returns true when it is over the limit. */
  return function limited(key: string): boolean {
    const now = Date.now();
    if (now - lastSweep > windowMs || hits.size >= maxKeys) sweep(now);
    // Still full after the sweep and `key` is new: drop the oldest keys (Map keeps insertion order).
    // A key that is already tracked doesn't grow the map, so it never forces an eviction.
    while (hits.size >= maxKeys && !hits.has(key)) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.delete(key); // re-insert so the key moves to the newest end
    hits.set(key, recent);
    return recent.length > max;
  };
}

/** The client's IP: the first x-forwarded-for entry, else x-real-ip, else "unknown". */
export const clientIp = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
