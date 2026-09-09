import { NextRequest, NextResponse } from "next/server";
import { rateLimit, validateCsrf, applySecurityHeaders, auditLog } from "@/lib/security";
import { requireClientIp } from "@/lib/security";
import {
  getRefreshToken,
  rotateRefreshToken,
  setAuthCookies,
  clearAuthCookies,
  sanitizeUser,
} from "@/lib/auth";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = requireClientIp(request);
  const traceId = crypto.randomUUID();

  if (!validateCsrf(request)) {
    auditLog.emit("CSRF_VALIDATION_FAILED", request, {
      ip,
      traceId,
      context: { endpoint: "/api/auth/refresh" },
    });
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "CSRF validation failed" },
        { status: 403 }
      )
    );
  }

  const rl = await rateLimit.refresh(ip);
  if (!rl.success) {
    auditLog.emit("RATE_LIMIT_EXCEEDED", request, {
      ip,
      traceId,
      context: { limiter: "refresh", limit: rl.limit, remaining: rl.remaining },
    });
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "Too many requests. Please try again later." },
        { status: 429, headers: rl.headers }
      )
    );
  }

  const refreshToken = await getRefreshToken();

  if (!refreshToken) {
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "No refresh token provided" },
        { status: 401 }
      )
    );
  }

  const result = await rotateRefreshToken(refreshToken);

  if (!result.ok) {
    const isConcurrent = result.code === "CONCURRENT_REFRESH";
    const isReuse = result.code === "REFRESH_TOKEN_REUSE";

    if (isReuse) {
      auditLog.emit("AUTH_REFRESH_REUSE_DETECTED", request, {
        ip,
        traceId,
      });
    }

    const response = NextResponse.json(
      { success: false, error: result.error, code: result.code },
      { status: result.status }
    );
    if (!isConcurrent) {
      await clearAuthCookies(response);
    }
    return applySecurityHeaders(response);
  }

  auditLog.emit("AUTH_TOKEN_ROTATED", request, {
    ip,
    userId: result.user._id.toString(),
    sid: result.sid,
    traceId,
  });

  const response = NextResponse.json(
    { success: true, data: { user: sanitizeUser(result.user) } },
    { status: 200 }
  );

  await setAuthCookies(result.accessToken, result.refreshToken, response);
  return applySecurityHeaders(response);
}
