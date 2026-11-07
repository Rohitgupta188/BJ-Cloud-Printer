/**
 * Shared SKU utilities for parsing, normalizing, and formatting SKUs
 * across generate.ts, preview/route.ts, and frontend components.
 */

export function escapeRegex(text: string): string {
  return text.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

/**
 * Format a SKU for the printer UI preview, physical label QR code, and Excel export
 * (prefixes '1' if not already present).
 */
export function formatPrinterSku(sku?: string): string {
  if (!sku) return "";
  const s = sku.trim();
  if (!s) return "";
  return s.startsWith("1") ? s : `1${s}`;
}

/**
 * Extract the integer sequence number from a SKU for a given prefix.
 * Handles both "DZGR2235" and "1DZGR2235".
 * Returns null if the SKU does not match the prefix or has trailing non-digits (e.g. "DZGR35210-c").
 */
export function parseSkuSequence(sku: string | undefined | null, prefix: string): number | null {
  if (!sku || !prefix) return null;
  const cleanPrefix = prefix.trim();
  if (!cleanPrefix) return null;

  // Match optional leading '1', the prefix (case-insensitive), and digits to the end
  const regex = new RegExp(`^(?:1)?${escapeRegex(cleanPrefix)}(\\d+)$`, "i");
  const match = sku.trim().match(regex);
  if (!match) return null;

  const num = parseInt(match[1], 10);
  return isNaN(num) ? null : num;
}

/**
 * MongoDB query regex helper to find all SKUs matching a prefix with or without leading '1'.
 */
export function buildSkuQueryRegex(prefix: string) {
  return {
    $regex: `^1?${escapeRegex(prefix.trim())}(\\d+)$`,
    $options: "i",
  };
}

/**
 * Given a base SKU like "1DZGR2235" or "DZGR2235" and an offset,
 * returns the incremented SKU preserving zero-padding width.
 */
export function offsetSku(baseSku: string, offset: number): string {
  if (offset === 0) return baseSku;
  const match = baseSku.match(/^(.*?)(\d+)$/);
  if (!match) return baseSku;
  const [, prefixPart, numStr] = match;
  const next = String(Number(numStr) + offset).padStart(numStr.length, "0");
  return prefixPart + next;
}

