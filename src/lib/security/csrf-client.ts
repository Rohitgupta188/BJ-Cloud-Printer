const CSRF_COOKIE = "csrf_token";

export function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  return (
    document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${CSRF_COOKIE}=`))
      ?.split("=")[1] ?? ""
  );
}
export function csrfHeaders(): { "X-CSRF-Token": string } {
  return { "X-CSRF-Token": getCsrfToken() };
}
