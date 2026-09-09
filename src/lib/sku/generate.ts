import type { Connection } from "mongoose";
import { getSkuSequenceModel } from "@/models/printer/SkuSequence";
import { getCatalogModel } from "@/models/catalog/Catalog";

function escapeRegex(text: string): string {
  return text.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

async function findCatalogMax(prefix: string, catalogConn: Connection): Promise<number> {
  const regex = { $regex: `^${escapeRegex(prefix)}(\\d+)$`, $options: "" };

  const docs = await getCatalogModel(catalogConn)
    .find({ sku: regex }, { sku: 1, _id: 0 })
    .lean();

  let max = 0;
  for (const doc of docs) {
    const n = parseInt(doc.sku.slice(prefix.length), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max;
}

export interface GenerateSkuOptions {
  catalogConn: Connection;  // BJ-Dashboard DB — read-only source of truth
  printerConn: Connection;  // BJ-Printer DB — read-write
  prefix: string;           // e.g. "TRTP"
}

export async function generateSku(options: GenerateSkuOptions): Promise<string> {
  const { catalogConn, printerConn, prefix } = options;
  const upper = prefix.toUpperCase();
  const SkuSequence = getSkuSequenceModel(printerConn);

  const exists = await SkuSequence.exists({ prefix: upper });

  if (!exists) {
    const catalogMax = await findCatalogMax(upper, catalogConn);
    await SkuSequence.findOneAndUpdate(
      { prefix: upper },
      { $setOnInsert: { seq: catalogMax } },
      { upsert: true }
    );
  }

  const result = await SkuSequence.findOneAndUpdate(
    { prefix: upper },
    { $inc: { seq: 1 } },
    { new: true }
  );

  if (!result) {
    throw new Error(
      `[sku] Sequence document missing for prefix "${upper}" after initialization.`
    );
  }

  console.log(`[sku] Generated "${upper}${result.seq}"`);

  return `${upper}${result.seq}`;
}
