import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { applySecurityHeaders } from "@/lib/security";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { getCatalogModel } from "@/models/catalog/Catalog";

type Ctx = { params: Promise<{ designNumber: string }> };

export const GET = withAuth<Ctx>(async (request: NextRequest, ctx) => {
  const { designNumber } = await ctx.params;
  const dn = designNumber?.trim();

  if (!dn) {
    return applySecurityHeaders(
      NextResponse.json({ success: false, error: "designNumber is required" }, { status: 400 })
    );
  }

  try {
    const { connection } = await connectToCatalogDb();
    const Catalog = getCatalogModel(connection);

    const item = await Catalog.findOne(
      { designNumber: { $regex: `^${dn.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")}$`, $options: "i" } },
      {
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
        _id: 0,
      }
    ).lean();

    if (!item) {
      return applySecurityHeaders(
        NextResponse.json({ success: false, error: "Design number not found" }, { status: 404 })
      );
    }

    return applySecurityHeaders(
      NextResponse.json({ success: true, data: item }, { status: 200 })
    );
  } catch (err) {
    console.error("[GET /api/catalog/design]", err);
    return applySecurityHeaders(
      NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
    );
  }
});
