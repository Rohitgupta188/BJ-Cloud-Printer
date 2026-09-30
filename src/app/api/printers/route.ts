import { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth";
import { getAvailablePrinters } from "@/lib/printer/registry";
import { success, serverError } from "@/lib/api-handling/api-response";

export const runtime = "nodejs";

/**
 * GET /api/printers
 * Returns the list of registered, enabled printers for user selection.
 */
export const GET = withAuth(async (_request: NextRequest) => {
  try {
    const printers = getAvailablePrinters();
    return success({ printers });
  } catch (err) {
    console.error("[GET /api/printers]", err);
    return serverError("Failed to fetch available printers");
  }
});
