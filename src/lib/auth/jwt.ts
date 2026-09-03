import { SignJWT, jwtVerify, errors, type JWTPayload } from "jose";

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[jwt] ${name} is not defined.`);
  }

  return value;
}

const JWT_ACCESS_SECRET = requiredEnv("JWT_ACCESS_SECRET");
const JWT_REFRESH_SECRET = requiredEnv("JWT_REFRESH_SECRET");
const JWT_ISSUER = requiredEnv("JWT_ISSUER");
const JWT_AUDIENCE = requiredEnv("JWT_AUDIENCE");
const ACCESS_TOKEN_TTL = requiredEnv("ACCESS_TOKEN_TTL");
const REFRESH_TOKEN_TTL = requiredEnv("REFRESH_TOKEN_TTL");

const accessSecretKey = new TextEncoder().encode(JWT_ACCESS_SECRET);
const refreshSecretKey = new TextEncoder().encode(JWT_REFRESH_SECRET);

function getAccessSecretKey(): Uint8Array {
  return accessSecretKey;
}

function getRefreshSecretKey(): Uint8Array {
  return refreshSecretKey;
}

export interface JwtPayload {
  sub: string;
  email: string;
  username: string;
  role: "admin" | "employee";
  type: "access" | "refresh";
  sid: string;
}

export function isJwtPayload(payload: JWTPayload): payload is JwtPayload & JWTPayload {
  return (
    typeof payload.sub === "string" &&
    typeof payload.email === "string" &&
    typeof payload.username === "string" &&
    (payload.role === "admin" || payload.role === "employee") &&
    (payload.type === "access" || payload.type === "refresh") &&
    typeof payload.sid === "string"
  );
}

export async function signAccessToken(
  payload: Omit<JwtPayload, "type">
): Promise<string> {
  return new SignJWT({ ...payload, type: "access" as const })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .setJti(crypto.randomUUID())
    .sign(getAccessSecretKey());
}

async function signRefreshToken(
  payload: Omit<JwtPayload, "type">
): Promise<string> {
  return new SignJWT({ ...payload, type: "refresh" as const })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(REFRESH_TOKEN_TTL)
    .setJti(crypto.randomUUID())
    .sign(getRefreshSecretKey());
}

export async function signTokenPair(
  payload: Omit<JwtPayload, "type" | "sid"> & { sid?: string }
): Promise<{ accessToken: string; refreshToken: string; sid: string }> {
  const sid = payload.sid ?? crypto.randomUUID();
  const full = { ...payload, sid };

  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(full),
    signRefreshToken(full),
  ]);

  return { accessToken, refreshToken, sid };
}

export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type VerifyResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; error: "expired" | "invalid" };

export async function verifyToken(
  token: string,
  expectedType?: "access" | "refresh"
): Promise<VerifyResult> {
  const key =
    expectedType === "refresh" ? getRefreshSecretKey() : getAccessSecretKey();

  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["HS256"],
    });

    if (!isJwtPayload(payload)) {
      return { ok: false, error: "invalid" };
    }

    if (expectedType && payload.type !== expectedType) {
      return { ok: false, error: "invalid" };
    }

    return { ok: true, payload };
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      return { ok: false, error: "expired" };
    }
    return { ok: false, error: "invalid" };
  }
}
