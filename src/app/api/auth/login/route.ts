import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { auditLog, rateLimit, validateCsrf } from "@/lib/security";
import { requireClientIp } from "@/lib/security";
import { loginUser, pruneOldSessions, sanitizeUser, setAuthCookies } from "@/lib/auth";
import {
  forbidden,
  tooManyRequests,
  error,
  validationFailed,
  success,
} from "@/lib/api-handling/api-response";

const LoginSchema = z.object({
  email: z.email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const reqStart = performance.now();
  const ip = requireClientIp(request);
  const traceId = crypto.randomUUID();

  if (!validateCsrf(request)) {
    auditLog.emit("CSRF_VALIDATION_FAILED", request, {
      ip,
      traceId,
      context: { endpoint: "/api/auth/login" },
    });
    return forbidden();
  }

  const rlStart = performance.now();
  const rl = await rateLimit.login(ip);
  const rlMs = Math.round(performance.now() - rlStart);

  if (!rl.success) {
    auditLog.emit("RATE_LIMIT_EXCEEDED", request, {
      ip,
      traceId,
      context: { limiter: "login", limit: rl.limit, remaining: rl.remaining },
    });
    return tooManyRequests("Too many login attempts. Please wait a minute.", rl.headers);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid request body", 400);
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return validationFailed(
      parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
    );
  }

  const result = await loginUser(parsed.data);

  if (!result.ok) {
    auditLog.emit("AUTH_LOGIN_FAILURE", request, {
      ip,
      traceId,
      context: { reason: "INVALID_CREDENTIALS" },
    });
    return error("Invalid email or password", 401);
  }

  // Safe background session pruning using Next.js after()
  // Guarantees Vercel serverless keeps function alive until completed
  // while returning the HTTP login response to the user instantly.
  after(async () => {
    try {
      const pruneStart = performance.now();
      await pruneOldSessions(result.user._id.toString(), result.sid);
      const pruneMs = Math.round(performance.now() - pruneStart);
      console.log(`[AUTH_TIMING] background_prune=${pruneMs}ms traceId=${traceId}`);
    } catch (err) {
      console.error("[login] Session pruning error:", err);
    }
  });

  const totalMs = Math.round(performance.now() - reqStart);
  console.log(
    JSON.stringify({
      event: "AUTH_LOGIN_PERF",
      traceId,
      totalMs,
      rateLimitMs: rlMs,
      dbInitMs: result.timings?.dbInitMs ?? 0,
      userLookupMs: result.timings?.userLookupMs ?? 0,
      bcryptMs: result.timings?.bcryptMs ?? 0,
      tokenSignMs: result.timings?.tokenSignMs ?? 0,
      sessionCreateMs: result.timings?.sessionCreateMs ?? 0,
    })
  );

  auditLog.emit("AUTH_LOGIN_SUCCESS", request, {
    ip,
    userId: result.user._id.toString(),
    sid: result.sid,
    traceId,
  });

  const response = success({ user: sanitizeUser(result.user) });
  await setAuthCookies(result.accessToken, result.refreshToken, response);
  return response;
}
