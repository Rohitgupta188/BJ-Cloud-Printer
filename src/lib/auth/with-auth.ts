import { NextRequest, NextResponse } from "next/server";
import { verifyToken, type JwtPayload } from "./jwt";
import {
  getAccessToken,
  getRefreshToken,
  setAuthCookies,
  clearAuthCookies,
} from "./cookies";
import { rotateRefreshToken } from "./auth.service";
import { getPrinterModels } from "@/lib/db/printer";

export type AuthenticatedRequest = {
  user: JwtPayload;
};

export type AuthOptions = {
  requireRole?: "admin" | "employee";
};

type RouteHandler<T = Record<string, unknown>> = (
  req: NextRequest,
  context: AuthenticatedRequest & T
) => Promise<NextResponse>;

export function withAuth<T = Record<string, unknown>>(
  handler: RouteHandler<T>,
  options?: AuthOptions
) {
  return async (req: NextRequest, context: T) => {
    const accessToken = await getAccessToken();
    let result = accessToken ? await verifyToken(accessToken, "access") : null;

    if (result?.ok) {
      const { PrinterSession } = await getPrinterModels();
      const session = await PrinterSession.findOne({
        userId: result.payload.sub,
        sessionId: result.payload.sid,
      });

      if (!session) {
        result = null;
      } else {
        if (
          options?.requireRole &&
          result.payload.role !== options.requireRole
        ) {
          return NextResponse.json(
            { error: "Forbidden: Insufficient permissions" },
            { status: 403 }
          );
        }
        return handler(req, { ...context, user: result.payload });
      }
    }

    const refreshToken = await getRefreshToken();

    if (!refreshToken) {
      const response = NextResponse.json(
        { error: "Session expired. Please log in again." },
        { status: 401 }
      );
      await clearAuthCookies(response);
      return response;
    }

    const refreshResult = await rotateRefreshToken(refreshToken);

    if (!refreshResult.ok) {
      const isConcurrent = refreshResult.code === "CONCURRENT_REFRESH";
      const response = NextResponse.json(
        { error: refreshResult.error, code: refreshResult.code },
        { status: refreshResult.status }
      );
      if (!isConcurrent) {
        await clearAuthCookies(response);
      }
      return response;
    }

    if (
      options?.requireRole &&
      refreshResult.user.role !== options.requireRole
    ) {
      return NextResponse.json(
        { error: "Forbidden: Insufficient permissions" },
        { status: 403 }
      );
    }

    const response = await handler(req, {
      ...context,
      user: {
        sub: refreshResult.user._id.toString(),
        email: refreshResult.user.email,
        username: refreshResult.user.username,
        role: refreshResult.user.role,
        type: "access",
        sid: refreshResult.sid,
      },
    });

    await setAuthCookies(
      refreshResult.accessToken,
      refreshResult.refreshToken,
      response
    );
    return response;
  };
}

export async function getCurrentUser(): Promise<JwtPayload | null> {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;
  const result = await verifyToken(accessToken, "access");
  if (!result.ok) return null;

  const { PrinterSession } = await getPrinterModels();
  const session = await PrinterSession.findOne({
    userId: result.payload.sub,
    sessionId: result.payload.sid,
  });
  if (!session) return null;

  return result.payload;
}
