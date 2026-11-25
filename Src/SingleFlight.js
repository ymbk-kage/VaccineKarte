// Time-limited single-flight for work shared between concurrent requests in one isolate.
//
// Why a time limit: Workers cancels the outbound I/O of a request once that request is cancelled (e.g. the
// browser tab closes). A promise started by that request then never settles, and every later request that
// joined it would wait forever (observed 2026-10-16: /api/search and /api/meta hung 87 s with no log line).
// Each caller therefore waits at most maxAgeMs, and an entry older than maxAgeMs is abandoned and restarted.

// Upper bound for one outbound call to Google or Access (headers + body)
export const FETCH_TIMEOUT_MS = 15 * 1000;
// How long a shared in-flight entry may be joined or awaited before it is treated as orphaned
export const INFLIGHT_MAX_AGE_MS = 20 * 1000;

/**
 * Build fetch options with an abort deadline (keeps any options already given).
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]
 * @returns {RequestInit}
 */
export function withTimeout(init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  // AbortSignal.timeout rejects the fetch (and its body read) once the deadline passes
  return { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

/**
 * Create a single-flight runner.
 * @param {{now?: () => number, maxAgeMs?: number, timeoutError?: () => Error}} [options]
 * @returns {(key: string, factory: () => Promise<any>) => Promise<any>}
 */
export function createSingleFlight({
  now = () => Date.now(),
  maxAgeMs = INFLIGHT_MAX_AGE_MS,
  timeoutError = () => new Error("in-flight work timed out"),
} = {}) {
  // Current shared entry: {key, startedAt, promise}
  let current = null;

  return function run(key, factory) {
    // Start new work when nothing is running, the key differs, or the running entry looks orphaned
    if (!current || current.key !== key || now() - current.startedAt >= maxAgeMs) {
      const entry = { key, startedAt: now(), promise: null };
      // Run the factory asynchronously and clear the slot once it settles (only if still ours)
      entry.promise = Promise.resolve()
        .then(factory)
        .finally(() => {
          if (current === entry) current = null;
        });
      current = entry;
    }
    const entry = current;
    // Each caller waits only for what is left of the entry's lifetime, on its own timer
    const remaining = Math.max(0, maxAgeMs - (now() - entry.startedAt));
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError()), remaining);
    });
    // Whichever settles first wins; the timer is always released
    return Promise.race([entry.promise, deadline]).finally(() => clearTimeout(timer));
  };
}
