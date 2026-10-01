/**
 * Fixed-window, in-memory rate limiter. On Lambda it's per instance, which is
 * enough to stop a runaway client loop; API Gateway throttling is the backstop.
 */
export function createRateLimiter({ limit, windowMs }: { limit: number; windowMs: number }) {
  const windows = new Map<string, { start: number; count: number }>();

  return function allow(key: string, now = Date.now()): boolean {
    const window = windows.get(key);
    if (!window || now - window.start >= windowMs) {
      if (windows.size > 10_000) windows.clear();
      windows.set(key, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= limit;
  };
}
