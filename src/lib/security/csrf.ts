import { NextRequest, NextResponse } from "next/server";

export const CSRF_COOKIE = "csrf_token";
export const CSRF_HEADER = "x-csrf-token";

const CSRF_MAX_AGE = 60 * 60 * 24; 

const IS_PRODUCTION = process.env.NODE_ENV === "production";

function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

export function setCsrfCookie(response: NextResponse): NextResponse {
  const token = generateCsrfToken();
  response.cookies.set(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: IS_PRODUCTION,
    sameSite: "strict",
    path: "/",
    maxAge: CSRF_MAX_AGE,
  });
  return response;
}

export function validateCsrf(request: NextRequest): boolean {
  const method = request.method.toUpperCase();

  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }

  const cookieToken = request.cookies.get(CSRF_COOKIE)?.value ?? "";
  const headerToken = request.headers.get(CSRF_HEADER) ?? "";

  if (!TOKEN_RE.test(cookieToken) || !TOKEN_RE.test(headerToken)) {
    return false;
  }

  return timingSafeEqual(cookieToken, headerToken);
}
