import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit, validateCsrf, applySecurityHeaders, auditLog } from "@/lib/security";
import { requireClientIp } from "@/lib/security";
import { loginUser, sanitizeUser, setAuthCookies } from "@/lib/auth";

const LoginSchema = z.object({
  email: z.email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = requireClientIp(request);
  console.log(ip);
  
  const traceId = crypto.randomUUID();

  if (!validateCsrf(request)) {
    auditLog.emit("CSRF_VALIDATION_FAILED", request, {
      ip,
      traceId,
      context: { endpoint: "/api/auth/login" },
    });
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "CSRF validation failed" },
        { status: 403 }
      )
    );
  }

  const rl = await rateLimit.login(ip);
  if (!rl.success) {
    auditLog.emit("RATE_LIMIT_EXCEEDED", request, {
      ip,
      traceId,
      context: { limiter: "login", limit: rl.limit, remaining: rl.remaining },
    });
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "Too many login attempts. Please wait a minute." },
        { status: 429, headers: rl.headers }
      )
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "Invalid request body" },
        { status: 400 }
      )
    );
  }

  const parsed = LoginSchema.safeParse(body);
  console.log(parsed);
  
  if (!parsed.success) {
    return applySecurityHeaders(
      NextResponse.json(
        {
          success: false,
          error: "Validation failed",
          details: parsed.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 422 }
      )
    );
  }

  const result = await loginUser(parsed.data);
  console.log(result);
  
  if (!result.ok) {
    auditLog.emit("AUTH_LOGIN_FAILURE", request, {
      ip,
      traceId,
      context: { reason: "INVALID_CREDENTIALS" },
    });
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "Invalid email or password" },
        { status: 401 }
      )
    );
  }

  auditLog.emit("AUTH_LOGIN_SUCCESS", request, {
    ip,
    userId: result.user._id.toString(),
    sid: result.sid,
    traceId,
  });

  const response = NextResponse.json(
    {
      success: true,
      data: { user: sanitizeUser(result.user) },
    },
    { status: 200 }
  );

  await setAuthCookies(result.accessToken, result.refreshToken, response);
  return applySecurityHeaders(response);
}
