import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { connectToPrinterDb } from "@/lib/db/printer";
import { generateSku } from "@/lib/sku/generate";
import { validateCsrf, applySecurityHeaders } from "@/lib/security";

const Schema = z.object({
  prefix: z
    .string()
    .min(1, "Prefix is required")
    .max(20)
    .regex(/^[A-Z0-9]+$/i, "Prefix must be alphanumeric"),
});

export const POST = withAuth(async (request: NextRequest) => {
  if (!validateCsrf(request)) {
    return applySecurityHeaders(
      NextResponse.json({ success: false, error: "CSRF validation failed" }, { status: 403 })
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Validation failed",
        details: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      },
      { status: 422 }
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

    return NextResponse.json({ success: true, data: { sku } }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/sku/generate]", err);
    return NextResponse.json({ success: false, error: "Failed to generate SKU" }, { status: 500 });
  }
});
