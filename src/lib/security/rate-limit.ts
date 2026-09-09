import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  headers: Record<string, string>;
}

export interface RateLimitConfig {
  name: string;
  maxRequests: number;
  window: `${number} ${"s" | "m" | "h" | "d"}`;
  windowMs: number;
}


const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const hasRedis = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

if (!hasRedis) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Rate limiting requires Upstash in production");
  }

  console.warn(
    JSON.stringify({
      level: "warn",
      service: "rate-limit",
      msg:
        "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set. " +
        "Falling back to in-memory rate limiting. " +
        "This is NOT safe for multi-instance production deployments.",
      timestamp: new Date().toISOString(),
    })
  );
}

const redis = hasRedis
  ? new Redis({ url: UPSTASH_URL!, token: UPSTASH_TOKEN! })
  : null;

function buildHeaders(
  success: boolean,
  limit: number,
  remaining: number,
  resetMs: number
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(Math.ceil(resetMs / 1000)),
  };

  if (!success) {
    headers["Retry-After"] = String(
      Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))
    );
  }

  return headers;
}

const MEM_MAX_BUCKETS = 10_000;

interface MemBucket {
  count: number;
  reset: number;
}

function makeMemoryLimiter(config: RateLimitConfig) {
  const { maxRequests, windowMs } = config;
  const buckets = new Map<string, MemBucket>();

  function evict(): void {
    if (buckets.size < MEM_MAX_BUCKETS) return;

    const now = Date.now();

    for (const [key, b] of buckets) {
      if (now > b.reset) buckets.delete(key);
      if (buckets.size < MEM_MAX_BUCKETS * 0.8) return;
    }

    const toRemove = Math.ceil(MEM_MAX_BUCKETS * 0.2);
    let removed = 0;
    for (const key of buckets.keys()) {
      if (removed >= toRemove) break;
      buckets.delete(key);
      removed++;
    }
  }

  return {
    async limit(key: string): Promise<RateLimitResult> {
      const now = Date.now();
      evict();

      const bucket = buckets.get(key);

      if (!bucket || now > bucket.reset) {
        const reset = now + windowMs;
        buckets.set(key, { count: 1, reset });
        return {
          success: true,
          limit: maxRequests,
          remaining: maxRequests - 1,
          reset,
          headers: buildHeaders(true, maxRequests, maxRequests - 1, reset),
        };
      }

      bucket.count += 1;
      const remaining = Math.max(0, maxRequests - bucket.count);
      const success = bucket.count <= maxRequests;

      return {
        success,
        limit: maxRequests,
        remaining,
        reset: bucket.reset,
        headers: buildHeaders(success, maxRequests, remaining, bucket.reset),
      };
    },
  };
}

interface RateLimiter {
  limit(key: string): Promise<RateLimitResult>;
}

export function createLimiter(config: RateLimitConfig): RateLimiter {
  const { name, maxRequests, window, windowMs } = config;

  if (redis) {
    const upstash = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(maxRequests, window),
      analytics: true,
      prefix: `bj-printer:rl:${name}`,
      // Ephemeral in-process cache absorbs hot-key latency spikes (Upstash best practice).
      ephemeralCache: new Map(),
    });

    return {
      async limit(key: string): Promise<RateLimitResult> {
        try {
          const { success, limit, remaining, reset } = await upstash.limit(key);
          return {
            success,
            limit,
            remaining,
            reset,
            headers: buildHeaders(success, limit, remaining, reset),
          };
        } catch (err) {
          console.error(
            JSON.stringify({
              level: "error",
              service: "rate-limit",
              limiter: name,
              msg: "Redis rate-limit check failed — failing open",
              error: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            })
          );
          const reset = Date.now() + windowMs;
          return {
            success: true,
            limit: maxRequests,
            remaining: maxRequests,
            reset,
            headers: buildHeaders(true, maxRequests, maxRequests, reset),
          };
        }
      },
    };
  }

  return makeMemoryLimiter(config);
}

function createDualLimiter(
  sustained: RateLimiter,
  burst: RateLimiter
): RateLimiter {
  return {
    async limit(key: string): Promise<RateLimitResult> {
      const [sustainedRes, burstRes] = await Promise.all([
        sustained.limit(key),
        burst.limit(key),
      ]);

      const success = sustainedRes.success && burstRes.success;

      const binding = !burstRes.success ? burstRes : sustainedRes;
      const remaining = Math.min(sustainedRes.remaining, burstRes.remaining);

      return {
        success,
        limit: binding.limit,
        remaining,
        reset: binding.reset,
        headers: buildHeaders(success, binding.limit, remaining, binding.reset),
      };
    },
  };
}

const loginSustained = createLimiter({
  name: "login-sustained",
  maxRequests: 5,
  window: "1 m",
  windowMs: 60_000,
});

const loginBurst = createLimiter({
  name: "login-burst",
  maxRequests: 2,
  window: "10 s",
  windowMs: 10_000,
});

const limiters = {
  _login: createDualLimiter(loginSustained, loginBurst),
  _refresh: createLimiter({ name: "refresh", maxRequests: 30, window: "1 m", windowMs: 60_000 }),
  _printJob: createLimiter({ name: "print-job", maxRequests: 20, window: "1 m", windowMs: 60_000 }),
  _global: createLimiter({ name: "global", maxRequests: 120, window: "1 m", windowMs: 60_000 }),
} as const;

export const rateLimit = {
  login:    (key: string) => limiters._login.limit(key),
  refresh:  (key: string) => limiters._refresh.limit(key),
  printJob: (key: string) => limiters._printJob.limit(key),
  global:   (key: string) => limiters._global.limit(key),
} as const;

export async function checkLoginRateLimit(ip: string): Promise<boolean> {
  return (await rateLimit.login(ip)).success;
}

export async function checkGlobalRateLimit(ip: string): Promise<boolean> {
  return (await rateLimit.global(ip)).success;
}

export async function checkRefreshRateLimit(ip: string): Promise<boolean> {
  return (await rateLimit.refresh(ip)).success;
}
