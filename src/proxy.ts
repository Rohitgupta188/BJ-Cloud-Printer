import { NextRequest, NextResponse } from "next/server";
import { jwtVerify, errors as joseErrors } from "jose";
import { setCsrfCookie } from "@/lib/security";

const ACCESS_COOKIE = "printer_access_token";
const REFRESH_COOKIE = "printer_refresh_token";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/refresh",
  "/api/auth/logout",
]);

const PUBLIC_PREFIXES = [
  "/_next/",
  "/favicon",
];

function getSecret(): Uint8Array {
  const secret = process.env.JWT_ACCESS_SECRET;

  if (!secret) throw new Error("[proxy] JWT_ACCESS_SECRET is not configured");

  return new TextEncoder().encode(secret);
}

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;

  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

async function isTokenValid(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, getSecret(), {
      issuer: process.env.JWT_ISSUER ?? "BJ-Printer",
      audience: process.env.JWT_AUDIENCE ?? "BJ-Printer",
      algorithms: ["HS256"],
    });
    return true;
  } catch (err) {
    void (err instanceof joseErrors.JWTExpired);
    return false;
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    if (pathname === "/login") {
      const accessToken = request.cookies.get(ACCESS_COOKIE)?.value;

      if (accessToken && (await isTokenValid(accessToken))) {
        return NextResponse.redirect(new URL("/", request.url));
      }

      const response = NextResponse.next();
      setCsrfCookie(response);
      return response;
    }
    return NextResponse.next();
  }

  const accessToken = request.cookies.get(ACCESS_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;

  if (!accessToken && !refreshToken) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (accessToken && (await isTokenValid(accessToken))) {
    return NextResponse.next();
  }

  if (refreshToken) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Run on all paths EXCEPT static files and image optimisation URLs.
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|map)).*)",
  ],
};
