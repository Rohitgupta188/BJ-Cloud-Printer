import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const ACCESS_COOKIE = "printer_access_token";
export const REFRESH_COOKIE = "printer_refresh_token";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

const ACCESS_MAX_AGE = 30 * 60;
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;

function accessOptions() {
  return {
    maxAge: ACCESS_MAX_AGE,
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "strict" as const,
    path: "/",
  };
}

function refreshOptions() {
  return {
    maxAge: REFRESH_MAX_AGE,
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "strict" as const,
    path: "/",
  };
}

export async function setAuthCookies(
  accessToken: string,
  refreshToken: string,
  res?: NextResponse
): Promise<void> {
  if (res) {
    res.cookies.set(ACCESS_COOKIE, accessToken, accessOptions());
    res.cookies.set(REFRESH_COOKIE, refreshToken, refreshOptions());
  } else {
    const cookieStore = await cookies();
    cookieStore.set(ACCESS_COOKIE, accessToken, accessOptions());
    cookieStore.set(REFRESH_COOKIE, refreshToken, refreshOptions());
  }
}

export async function getAccessToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(ACCESS_COOKIE)?.value;
}
export async function getRefreshToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(REFRESH_COOKIE)?.value;
}

export async function clearAuthCookies(res?: NextResponse): Promise<void> {
  if (res) {
    res.cookies.delete(ACCESS_COOKIE);
    res.cookies.delete(REFRESH_COOKIE);
  } else {
    const cookieStore = await cookies();
    cookieStore.delete(ACCESS_COOKIE);
    cookieStore.delete(REFRESH_COOKIE);
  }
}
