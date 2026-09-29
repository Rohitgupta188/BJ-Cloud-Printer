import { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { connectToPrinterDb } from "@/lib/db/printer";
import { getCatalogModel } from "@/models/catalog/Catalog";
import { success, error, notFound, serverError } from "@/lib/api-handling/api-response";

type Ctx = { params: Promise<{ designNumber: string }> };

export const GET = withAuth<Ctx>(async (request: NextRequest, ctx) => {
  const { designNumber } = await ctx.params;
  const dn = designNumber?.trim();

  if (!dn) {
    return error("designNumber is required", 400);
  }

  try {
    const { connection } = await connectToCatalogDb();
    const Catalog = getCatalogModel(connection);

    // 1. Try to find a Catalog item that has reserved1 populated
    const escapedDn = dn.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
    const query = {
      $or: [
        { designNumber: { $regex: `^${escapedDn}$`, $options: "i" } },
        { imageName: { $regex: `^${escapedDn}(\\.jpg)?$`, $options: "i" } },
      ],
    };

    const projection = {
      sku: 1,
      designNumber: 1,
      imageName: 1,
      imageUrl: 1,
      storagePath: 1,
      itemType: 1,
      grossWeight: 1,
      netWeight: 1,
      stoneWeight: 1,
      metalType: 1,
      metalPurity: 1,
      collectionLine: 1,
      itemStatus: 1,
      reserved1: 1,
      reserved3: 1,
      _id: 0,
    };

    let item = await Catalog.findOne({
      ...query,
      reserved1: { $exists: true, $nin: [null, ""] },
    }, projection).lean();

    if (!item) {
      item = await Catalog.findOne(query, projection).lean();
    }

    // Fallback: If not found in Catalog or reserved1 is missing, check PrintJob history
    if (!item || !item.reserved1) {
      try {
        const { connection: printerConn } = await connectToPrinterDb();
        const { getPrintJobModel } = await import("@/models/printer/PrintJob");
        const PrintJob = getPrintJobModel(printerConn);

        const prevJob = await PrintJob.findOne(
          {
            designNumber: { $regex: `^${escapedDn}$`, $options: "i" },
            reserved1: { $exists: true, $nin: [null, ""] },
          },
          {
            sku: 1,
            designNumber: 1,
            imageName: 1,
            imageUrl: 1,
            reserved1: 1,
            _id: 0,
          }
        )
          .sort({ createdAt: -1 })
          .lean();

        if (prevJob) {
          if (!item) {
            item = prevJob as any;
          } else if (!item.reserved1 && prevJob.reserved1) {
            item.reserved1 = prevJob.reserved1;
          }
        }
      } catch (e) {
        console.error("[GET /api/catalog/design] Error checking PrintJob fallback:", e);
      }
    }

    if (!item) {
      return notFound("Design number not found");
    }

    return success(item);
  } catch (err) {
    console.error("[GET /api/catalog/design]", err);
    return serverError();
  }
});
