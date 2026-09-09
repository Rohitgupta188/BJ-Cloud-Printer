import { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { connectToPrinterDb } from "@/lib/db/printer";
import { getSkuSequenceModel } from "@/models/printer/SkuSequence";
import { getCatalogModel } from "@/models/catalog/Catalog";
import { getPrintJobModel } from "@/models/printer/PrintJob";
import { error, success, serverError } from "@/lib/api-handling/api-response";

function escapeRegex(text: string): string {
  return text.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

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
    const existing = await SkuSequence.findOne({ prefix: rawPrefix }, { seq: 1 }).lean();

    let nextSeq: number;

    if (existing && existing.seq > 0) {
      nextSeq = existing.seq + 1;
    } else {
      const regex = { $regex: `^${escapeRegex(rawPrefix)}(\\d+)$`, $options: "" };

      const [catalogDocs, jobDocs] = await Promise.all([
        getCatalogModel(catalogConn).find({ sku: regex }, { sku: 1, _id: 0 }).lean(),
        getPrintJobModel(printerConn).find({ sku: regex }, { sku: 1, _id: 0 }).lean(),
      ]);

      let max = 0;
      for (const doc of [...catalogDocs, ...jobDocs]) {
        const n = parseInt(doc.sku.slice(rawPrefix.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }

      nextSeq = max + 1;
    }

    const previewSku = `${rawPrefix}${nextSeq}`;
    return success({ sku: previewSku, rfid: previewSku });
  } catch (err) {
    console.error("[GET /api/sku/preview]", err);
    return serverError("Failed to preview SKU");
  }
});
