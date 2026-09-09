import { NextRequest, NextResponse } from "next/server";
import { rateLimit, validateCsrf, auditLog } from "@/lib/security";
import { requireClientIp } from "@/lib/security";
import {
  getRefreshToken,
  rotateRefreshToken,
  setAuthCookies,
  clearAuthCookies,
  sanitizeUser,
} from "@/lib/auth";
import {
  forbidden,
  tooManyRequests,
  unauthorized,
  error,
  success,
} from "@/lib/api-handling/api-response";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = requireClientIp(request);
  const traceId = crypto.randomUUID();

  if (!validateCsrf(request)) {
    auditLog.emit("CSRF_VALIDATION_FAILED", request, {
      ip,
      traceId,
      context: { endpoint: "/api/auth/refresh" },
    });
    return forbidden();
  }

  const rl = await rateLimit.refresh(ip);
  if (!rl.success) {
    auditLog.emit("RATE_LIMIT_EXCEEDED", request, {
      ip,
      traceId,
      context: { limiter: "refresh", limit: rl.limit, remaining: rl.remaining },
    });
    return tooManyRequests("Too many requests. Please try again later.", rl.headers);
  }

  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    return unauthorized("No refresh token provided");
  }

  const result = await rotateRefreshToken(refreshToken);

  if (!result.ok) {
    const isConcurrent = result.code === "CONCURRENT_REFRESH";
    const isReuse = result.code === "REFRESH_TOKEN_REUSE";

    if (isReuse) {
      auditLog.emit("AUTH_REFRESH_REUSE_DETECTED", request, { ip, traceId });
    }

    const response = error(result.error, result.status, undefined);
    if (!isConcurrent) {
      await clearAuthCookies(response);
    }
    return response;
  }

  auditLog.emit("AUTH_TOKEN_ROTATED", request, {
    ip,
    userId: result.user._id.toString(),
    sid: result.sid,
    traceId,
  });

  const response = success({ user: sanitizeUser(result.user) });
  await setAuthCookies(result.accessToken, result.refreshToken, response);
  return response;
}
