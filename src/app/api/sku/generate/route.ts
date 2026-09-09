import { NextRequest } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { connectToPrinterDb } from "@/lib/db/printer";
import { generateSku } from "@/lib/sku/generate";
import { validateCsrf } from "@/lib/security";
import {
  forbidden,
  error,
  validationFailed,
  created,
  serverError,
} from "@/lib/api-handling/api-response";

const Schema = z.object({
  prefix: z
    .string()
    .min(1, "Prefix is required")
    .max(20)
    .regex(/^[A-Z0-9]+$/i, "Prefix must be alphanumeric"),
});

export const POST = withAuth(async (request: NextRequest) => {
  if (!validateCsrf(request)) {
    return forbidden();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid request body", 400);
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return validationFailed(
      parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
    );
  }

  try {
    const [catalogConn, printerConn] = await Promise.all([
      connectToCatalogDb(),
      connectToPrinterDb(),
    ]);

    const sku = await generateSku({
      catalogConn: catalogConn.connection,
      printerConn: printerConn.connection,
      prefix: parsed.data.prefix.toUpperCase(),
    });

    return created({ sku });
  } catch (err) {
    console.error("[POST /api/sku/generate]", err);
    return serverError("Failed to generate SKU");
  }
});
