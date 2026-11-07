import { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { connectToPrinterDb } from "@/lib/db/printer";
import { getSkuSequenceModel } from "@/models/printer/SkuSequence";
import { findMaxExistingSequence } from "@/lib/sku/generate";
import { formatPrinterSku } from "@/lib/sku/sku-utils";
import { error, success, serverError } from "@/lib/api-handling/api-response";

export const GET = withAuth(async (request: NextRequest) => {
  const url = new URL(request.url);
  const rawPrefix = url.searchParams.get("prefix")?.trim().toUpperCase();

  if (!rawPrefix || !/^[A-Z0-9]+$/.test(rawPrefix)) {
    return error("prefix query param is required and must be alphanumeric", 400);
  }

  try {
    const [{ connection: catalogConn }, { connection: printerConn }] = await Promise.all([
      connectToCatalogDb(),
      connectToPrinterDb(),
    ]);

    const SkuSequence = getSkuSequenceModel(printerConn);
    const [existingSeqDoc, maxExisting] = await Promise.all([
      SkuSequence.findOne({ prefix: rawPrefix }, { seq: 1 }).lean(),
      findMaxExistingSequence(rawPrefix, catalogConn, printerConn),
    ]);

    // Ensure preview is strictly greater than both Printer DB counter and Catalog max
    const currentMax = Math.max(existingSeqDoc?.seq ?? 0, maxExisting);
    const nextSeq = currentMax + 1;

    const baseSku = `${rawPrefix}${nextSeq}`;
    const previewSku = formatPrinterSku(baseSku);

    // Non-allocating preview: reads only, never consumes sequence numbers
    return success({ sku: previewSku, rfid: previewSku, rawSku: baseSku });
  } catch (err) {
    console.error("[GET /api/sku/preview]", err);
    return serverError("Failed to preview SKU");
  }
});
