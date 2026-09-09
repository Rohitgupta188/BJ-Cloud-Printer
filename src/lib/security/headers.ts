import { NextResponse } from "next/server";

export interface SecurityHeaderOptions {
  csp?: string;
}

const API_CSP = "default-src 'none'";

export function applySecurityHeaders(
  response: NextResponse,
  options?: SecurityHeaderOptions
): NextResponse {
  const csp = options?.csp ?? API_CSP;

  const headers: [string, string][] = [
    ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],


    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
    ["Content-Security-Policy", csp],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
  ];

  for (const [key, value] of headers) {
    response.headers.set(key, value);
  }

  response.headers.delete("X-Powered-By");

  return response;
}
