// In-memory token bucket per IP.  Not horizontally scalable; the api runs as a
// single container so one process holds the whole state.
export function createRateLimiter({ limit = 10, windowMs = 60_000 } = {}) {
  const buckets = new Map();

  function clientKey(req) {
    const fwd = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
    return fwd || req.ip || req.socket?.remoteAddress || 'unknown';
  }

  function sweep(now) {
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k);
    }
  }

  return function limiter(req, res, next) {
    const now = Date.now();
    if (buckets.size > 10_000) sweep(now);
    const key = clientKey(req);
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    const remaining = Math.max(0, limit - b.count);
    res.setHeader('x-ratelimit-limit', String(limit));
    res.setHeader('x-ratelimit-remaining', String(remaining));
    res.setHeader('x-ratelimit-reset', String(Math.ceil(b.resetAt / 1000)));
    if (b.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      res.setHeader('retry-after', String(retryAfter));
      return res.status(429).json({ error: `rate limit exceeded, retry in ${retryAfter}s` });
    }
    next();
  };
}
