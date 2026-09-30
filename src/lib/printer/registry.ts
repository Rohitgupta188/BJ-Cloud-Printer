/**
 * Server-Side Printer Registry
 *
 * Single source of truth for physical printers and their corresponding MQTT topics.
 *
 * Topic naming convention:
 *   printers/<printerId>/jobs
 *
 * Security & Routing Rule:
 *   The frontend only sends logical `printerId` (e.g. "mumbai-01").
 *   The backend resolves and validates the MQTT topic here.
 *   The frontend NEVER controls or supplies arbitrary MQTT topics.
 */

export interface PrinterConfig {
  /** Unique logical printer identifier (e.g. "mumbai-01") */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Physical location or workstation notes */
  description?: string;
  /** Full MQTT topic for publishing print jobs */
  topic: string;
  /** Whether the printer is active and accept jobs */
  enabled: boolean;
  /** Default printer pre-selected in the UI */
  isDefault?: boolean;
}

export type PrinterSummary = Pick<
  PrinterConfig,
  "id" | "name" | "description" | "enabled" | "isDefault"
>;

/**
 * Server-side printer registry.
 * To register a new physical printer (e.g. mumbai-03, delhi-01),
 * add it here.
 */
export const PRINTER_REGISTRY: Record<string, PrinterConfig> = {
  "mumbai-01": {
    id: "mumbai-01",
    name: "Mumbai Printer 01",
    description: "Shop Floor — Station 01 (TSC-TTP-244 Pro)",
    topic: "printers/mumbai-01/jobs",
    enabled: true,
    isDefault: true,
  },
  "mumbai-02": {
    id: "mumbai-02",
    name: "Mumbai Printer 02",
    description: "Shop Floor — Station 02 (TSC-TTP-244 Pro)",
    topic: "printers/mumbai-02/jobs",
    enabled: true,
    isDefault: false,
  },
};

export const DEFAULT_PRINTER_ID = "mumbai-01";

/**
 * Validates and retrieves a printer by its ID.
 * Returns null if the printer does not exist or is disabled.
 */
export function getPrinterById(printerId?: string | null): PrinterConfig | null {
  if (!printerId) return null;
  const normalizedId = printerId.trim().toLowerCase();
  const printer = PRINTER_REGISTRY[normalizedId];
  if (!printer || !printer.enabled) {
    return null;
  }
  return printer;
}

/**
 * Returns true if the given printer ID is registered and enabled.
 */
export function isValidPrinterId(printerId: string): boolean {
  return getPrinterById(printerId) !== null;
}

/**
 * Resolves the MQTT topic for a validated printer ID.
 * Throws an error if the printer is unknown or disabled.
 */
export function resolvePrinterTopic(printerId: string): string {
  const printer = getPrinterById(printerId);
  if (!printer) {
    throw new Error(`[printer-registry] Invalid or disabled printerId: "${printerId}"`);
  }
  return printer.topic;
}

/**
 * Returns a list of active printers safe for client consumption
 * (omitting internal MQTT topic strings).
 */
export function getAvailablePrinters(): PrinterSummary[] {
  return Object.values(PRINTER_REGISTRY)
    .filter((p) => p.enabled)
    .map(({ id, name, description, enabled, isDefault }) => ({
      id,
      name,
      description,
      enabled,
      isDefault: Boolean(isDefault),
    }));
}
