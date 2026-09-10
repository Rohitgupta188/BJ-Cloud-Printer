import { csrfHeaders } from "@/lib/security/csrf-client";

let refreshPromise: Promise<boolean> | null = null;

function refreshOnce(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { ...csrfHeaders() },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(input, { credentials: "include", ...init });

  if (res.status !== 401) {
    return res;
  }

  const refreshed = await refreshOnce();

  if (!refreshed) {
    return res;
  }

  return fetch(input, { credentials: "include", ...init });
}
