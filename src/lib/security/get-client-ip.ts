import { NextRequest } from "next/server";

function isValidIpv6(ip: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(ip)) return false;
  if ((ip.match(/::/g) ?? []).length > 1) return false;

  const hasCompressed = ip.includes("::");

  const isGroup = (s: string) => /^[0-9a-f]{1,4}$/i.test(s);

  if (!hasCompressed) {
    const groups = ip.split(":");
    return groups.length === 8 && groups.every(isGroup);
  }

  const [left, right] = ip.split("::");
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];

  if (!leftGroups.every(isGroup)) return false;
  if (!rightGroups.every(isGroup)) return false;

  return leftGroups.length + rightGroups.length <= 7;
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function normalizeIp(raw: string): string | null {
  let ip = raw.trim();
  if (!ip) return null;

  if (ip.startsWith("[")) {
    const closing = ip.indexOf("]");
    if (closing === -1) return null;

    const after = ip.slice(closing + 1);
    if (after !== "" && !/^:\d+$/.test(after)) return null;

    ip = ip.slice(1, closing);
  }

  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);

  if (!ip) return null;
  if (IPV4_RE.test(ip)) {
    const valid = ip.split(".").every((o) => {
      const n = parseInt(o, 10);
      return !isNaN(n) && n >= 0 && n <= 255;
    });
    return valid ? ip : null;
  }

  if (ip.includes(":") && isValidIpv6(ip)) return ip;

  return null;
}

export function getClientIp(request: NextRequest): string | null {

  const xffRaw = request.headers.get("x-forwarded-for");
  if (xffRaw) {
    const ip = normalizeIp(xffRaw.split(",")[0].trim());
    if (ip) return ip;
  }
  const xvffRaw = request.headers.get("x-vercel-forwarded-for");
  if (xvffRaw) {
    const ip = normalizeIp(xvffRaw.split(",")[0].trim());
    if (ip) return ip;
  }

  const xriRaw = request.headers.get("x-real-ip");
  if (xriRaw) {
    const ip = normalizeIp(xriRaw);
    if (ip) return ip;
  }

  if (process.env.NODE_ENV === "development") {
    return "127.0.0.1";
  }

  return null;
}

export function requireClientIp(request: NextRequest): string {
  const ip = getClientIp(request);

  if (ip) return ip;

  console.error(
    JSON.stringify({
      level: "error",
      service: "get-client-ip",
      msg:
        "Unable to resolve a valid client IP from x-forwarded-for, " +
        "x-vercel-forwarded-for, or x-real-ip. " +
        "On a plain Vercel deployment these headers are always set by the platform. " +
        "Check that no middleware is stripping them and that the function is " +
        "running in a Vercel environment (not local dev without a tunnel).",
      url: new URL(request.url).pathname,
      method: request.method,
      timestamp: new Date().toISOString(),
    })
  );

  throw new Error("Unable to determine client IP.");
}
