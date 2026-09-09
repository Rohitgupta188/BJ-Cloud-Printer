import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { logoutUser, clearAuthCookies } from "@/lib/auth";
import { validateCsrf, auditLog } from "@/lib/security";
import { requireClientIp } from "@/lib/security";
import { forbidden, success } from "@/lib/api-handling/api-response";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ip = requireClientIp(req);
  const traceId = crypto.randomUUID();

  if (!validateCsrf(req)) {
    auditLog.emit("CSRF_VALIDATION_FAILED", req, {
      ip,
      traceId,
      context: { endpoint: "/api/auth/logout" },
    });
    return forbidden();
  }

  try {
    await logoutUser(ctx.user.sub, ctx.user.sid);
  } catch (err) {
    console.error("[logout] Failed to revoke session:", err);
  }

  auditLog.emit("AUTH_LOGOUT", req, {
    ip,
    userId: ctx.user.sub,
    sid: ctx.user.sid,
    traceId,
  });

  const response = success({ message: "Signed out successfully" });
  await clearAuthCookies(response);
  return response;
});
