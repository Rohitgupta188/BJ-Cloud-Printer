import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;
import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { connectToPrinterDb } from "@/lib/db/printer";
import { getCatalogModel } from "@/models/catalog/Catalog";
import { getPrintJobModel } from "@/models/printer/PrintJob";
import { success, error, serverError } from "@/lib/api-handling/api-response";

const QueryItemSchema = z.object({
  sku: z.string().trim().optional(),
  designNumber: z.string().trim().optional(),
});

const RequestSchema = z.object({
  queries: z.array(QueryItemSchema).max(500, "Maximum 500 items per lookup"),
});

export interface LookupResultItem {
  sku?: string;
  designNumber?: string;
  prefix?: string;
  itemType?: string;
  grossWeight?: number;
  netWeight?: number;
  stoneWeight?: number;
  metalType?: string;
  metalPurity?: string;
  collectionLine?: string;
  reserved1?: string;
  reserved3?: string;
  imageUrl?: string;
  source: "catalog" | "printJob";
}

export const POST = withAuth(async (request: NextRequest) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON request body", 400);
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return error(parsed.error.issues[0]?.message || "Validation failed", 400);
  }

  const { queries } = parsed.data;
  if (!queries || queries.length === 0) {
    return success({ results: {} });
  }

  // Collect distinct normalized SKUs and Design Numbers
  const skus = Array.from(
    new Set(
      queries
        .map((q) => q.sku?.trim())
        .filter((s): s is string => !!s && s.length > 0)
    )
  );

  const designNumbers = Array.from(
    new Set(
      queries
        .map((q) => q.designNumber?.trim())
        .filter((d): d is string => !!d && d.length > 0)
    )
  );

  const resultMap: Record<string, LookupResultItem> = {};

  try {
    const [{ connection: catalogConn }, { connection: printerConn }] =
      await Promise.all([connectToCatalogDb(), connectToPrinterDb()]);

    const Catalog = getCatalogModel(catalogConn);
    const PrintJob = getPrintJobModel(printerConn);

    // 1. Search in Catalog
    const catalogConditions: Record<string, unknown>[] = [];
    if (skus.length > 0) {
      catalogConditions.push({
        sku: {
          $in: skus.map((s) => new RegExp(`^${escapeRegex(s)}$`, "i")),
        },
      });
    }
    if (designNumbers.length > 0) {
      catalogConditions.push({
        designNumber: {
          $in: designNumbers.map((d) => new RegExp(`^${escapeRegex(d)}$`, "i")),
        },
      });
    }

    if (catalogConditions.length > 0) {
      const catalogDocs = await Catalog.find(
        { $or: catalogConditions },
        {
          sku: 1,
          designNumber: 1,
          itemType: 1,
          grossWeight: 1,
          netWeight: 1,
          stoneWeight: 1,
          metalType: 1,
          metalPurity: 1,
          collectionLine: 1,
          reserved1: 1,
          reserved3: 1,
          imageUrl: 1,
          _id: 0,
        }
      ).lean();

      for (const doc of catalogDocs) {
        const item: LookupResultItem = {
          sku: doc.sku ?? undefined,
          designNumber: doc.designNumber ?? undefined,
          itemType: doc.itemType ?? undefined,
          prefix: doc.itemType || (doc.sku ? doc.sku.replace(/\d+$/, "") : undefined),
          grossWeight: doc.grossWeight ?? undefined,
          netWeight: doc.netWeight ?? undefined,
          stoneWeight: doc.stoneWeight ?? undefined,
          metalType: doc.metalType ?? undefined,
          metalPurity: doc.metalPurity ?? undefined,
          collectionLine: doc.collectionLine ?? undefined,
          reserved1: doc.reserved1 ? String(doc.reserved1) : undefined,
          reserved3: doc.reserved3 ? String(doc.reserved3) : undefined,
          imageUrl: doc.imageUrl ?? undefined,
          source: "catalog",
        };

        if (doc.sku) {
          resultMap[`sku:${doc.sku.toUpperCase()}`] = item;
        }
        if (doc.designNumber) {
          // If not already mapped by SKU, map by designNumber
          if (!resultMap[`dn:${doc.designNumber.toUpperCase()}`]) {
            resultMap[`dn:${doc.designNumber.toUpperCase()}`] = item;
          }
        }
      }
    }

    // 2. Identify missing items to look up in PrintJob history
    const missingSkus = skus.filter((s) => !resultMap[`sku:${s.toUpperCase()}`]);
    const missingDns = designNumbers.filter(
      (d) => !resultMap[`dn:${d.toUpperCase()}`]
    );

    const printJobConditions: Record<string, unknown>[] = [];
    if (missingSkus.length > 0) {
      printJobConditions.push({
        sku: {
          $in: missingSkus.map((s) => new RegExp(`^${escapeRegex(s)}$`, "i")),
        },
      });
    }
    if (missingDns.length > 0) {
      printJobConditions.push({
        designNumber: {
          $in: missingDns.map((d) => new RegExp(`^${escapeRegex(d)}$`, "i")),
        },
      });
    }

    if (printJobConditions.length > 0) {
      const jobDocs = await PrintJob.find(
        { $or: printJobConditions },
        {
          sku: 1,
          designNumber: 1,
          grossWeight: 1,
          netWeight: 1,
          stoneWeight: 1,
          metalType: 1,
          metalPurity: 1,
          collectionLine: 1,
          reserved1: 1,
          reserved3: 1,
          imageUrl: 1,
          _id: 0,
        }
      )
        .sort({ createdAt: -1 })
        .lean();

      for (const doc of jobDocs) {
        const item: LookupResultItem = {
          sku: doc.sku ?? undefined,
          designNumber: doc.designNumber ?? undefined,
          prefix: doc.sku ? doc.sku.replace(/\d+$/, "") : undefined,
          grossWeight: doc.grossWeight ?? undefined,
          netWeight: doc.netWeight ?? undefined,
          stoneWeight: doc.stoneWeight ?? undefined,
          metalType: doc.metalType ?? undefined,
          metalPurity: doc.metalPurity ?? undefined,
          collectionLine: doc.collectionLine ?? undefined,
          reserved1: doc.reserved1 ? String(doc.reserved1) : undefined,
          reserved3: doc.reserved3 ? String(doc.reserved3) : undefined,
          imageUrl: doc.imageUrl ?? undefined,
          source: "printJob",
        };

        if (doc.sku && !resultMap[`sku:${doc.sku.toUpperCase()}`]) {
          resultMap[`sku:${doc.sku.toUpperCase()}`] = item;
        }
        if (doc.designNumber && !resultMap[`dn:${doc.designNumber.toUpperCase()}`]) {
          resultMap[`dn:${doc.designNumber.toUpperCase()}`] = item;
        }
      }
    }

    return success({ results: resultMap });
  } catch (err) {
    console.error("[POST /api/catalog/lookup-batch]", err);
    return serverError("Failed to lookup catalog batch");
  }
});

function escapeRegex(text: string): string {
  return text.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}
