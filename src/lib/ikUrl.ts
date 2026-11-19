/**
 * Shared ImageKit URL helper.
 * Appends the standard transformation via plain string concatenation —
 * no URLSearchParams, no encoding of commas.
 *
 * Only transforms URLs under our ImageKit endpoint.
 * Strips any existing tr= param before appending the canonical one.
 */
const IK_PREFIX = "https://ik.imagekit.io/brahammandjewels/";

export function ikUrl(imageUrl: string | null | undefined): string | null {
  const url = (imageUrl ?? "").trim();
  if (!url) return null;
  if (!url.startsWith(IK_PREFIX)) return url;
  // Strip any existing tr= param, then append the standard one
  const [base, qs] = url.split("?", 2);
  const kept = qs ? qs.split("&").filter((p) => !p.startsWith("tr=")).join("&") : "";
  return kept ? `${base}?${kept}&tr=w-800,q-80,f-jpg` : `${base}?tr=w-800,q-80,f-jpg`;
}
