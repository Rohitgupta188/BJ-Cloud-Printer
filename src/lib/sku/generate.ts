import type { Connection } from "mongoose";
import { getSkuSequenceModel } from "@/models/printer/SkuSequence";
import { getCatalogModel } from "@/models/catalog/Catalog";
import { getPrintJobModel } from "@/models/printer/PrintJob";
import { buildSkuQueryRegex, parseSkuSequence } from "./sku-utils";

/**
 * Finds the highest sequence number for a prefix across both the Catalog DB
 * and existing PrintJobs in the Printer DB. Handles both "PREFIX123" and "1PREFIX123".
 */
export async function findMaxExistingSequence(
  prefix: string,
  catalogConn: Connection,
  printerConn?: Connection
): Promise<number> {
  const upper = prefix.toUpperCase().trim();
  const mongoRegex = buildSkuQueryRegex(upper);

  const catalogDocsPromise = getCatalogModel(catalogConn)
    .find({ sku: mongoRegex }, { sku: 1, _id: 0 })
    .lean();

  const printJobsPromise = printerConn
    ? getPrintJobModel(printerConn)
        .find({ sku: mongoRegex }, { sku: 1, _id: 0 })
        .lean()
    : Promise.resolve([]);

  const [catalogDocs, jobDocs] = await Promise.all([
    catalogDocsPromise,
    printJobsPromise,
  ]);

  let max = 0;
  for (const doc of catalogDocs) {
    if (doc.sku) {
      const seq = parseSkuSequence(doc.sku, upper);
      if (seq !== null && seq > max) max = seq;
    }
  }

  for (const doc of jobDocs) {
    if (doc.sku) {
      const seq = parseSkuSequence(doc.sku, upper);
      if (seq !== null && seq > max) max = seq;
    }
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
  const upper = prefix.toUpperCase().trim();
  const SkuSequence = getSkuSequenceModel(printerConn);

  // 1. Find the highest existing SKU in Catalog DB or PrintJobs
  const maxExisting = await findMaxExistingSequence(upper, catalogConn, printerConn);

  // 2. Ensure SkuSequence.seq is at least maxExisting atomically ($max only increases, never rolls back)
  await SkuSequence.findOneAndUpdate(
    { prefix: upper },
    {
      $setOnInsert: { prefix: upper },
      $max: { seq: maxExisting },
    },
    { upsert: true, returnDocument: "after" }
  );

  // 3. Atomically allocate the next sequence number
  const result = await SkuSequence.findOneAndUpdate(
    { prefix: upper },
    { $inc: { seq: 1 } },
    { returnDocument: "after" }
  );

  if (!result) {
    throw new Error(
      `[sku] Sequence document missing for prefix "${upper}" after initialization.`
    );
  }

  console.log(`[sku] Generated "${upper}${result.seq}" (prior max was ${maxExisting})`);
  return `${upper}${result.seq}`;
}

export interface GenerateSkuBatchOptions {
  catalogConn: Connection;
  printerConn: Connection;
  prefixes: string[]; // Order of prefixes matching the items
}

export async function generateSkuBatch(
  options: GenerateSkuBatchOptions
): Promise<string[]> {
  const { catalogConn, printerConn, prefixes } = options;
  if (prefixes.length === 0) return [];

  const SkuSequence = getSkuSequenceModel(printerConn);

  // 1. Group occurrences by prefix
  const prefixCounts = new Map<string, number>();
  for (const p of prefixes) {
    const upper = p.toUpperCase().trim();
    prefixCounts.set(upper, (prefixCounts.get(upper) ?? 0) + 1);
  }

  // 2. Atomically reserve blocks for each prefix
  const allocatedSequences = new Map<string, { current: number }>();

  for (const [upper, count] of prefixCounts.entries()) {
    // A. Query highest existing SKU across Catalog DB and PrintJobs
    const maxExisting = await findMaxExistingSequence(upper, catalogConn, printerConn);

    // B. Atomically ensure SkuSequence.seq >= maxExisting (without rollbacks)
    await SkuSequence.findOneAndUpdate(
      { prefix: upper },
      {
        $setOnInsert: { prefix: upper },
        $max: { seq: maxExisting },
      },
      { upsert: true, returnDocument: "after" }
    );

    // C. Atomically increment by the batch count
    const result = await SkuSequence.findOneAndUpdate(
      { prefix: upper },
      { $inc: { seq: count } },
      { returnDocument: "after" }
    );

    if (!result) {
      throw new Error(
        `[sku] Sequence document missing for prefix "${upper}" after batch allocation.`
      );
    }

    const startSeq = result.seq - count + 1;
    allocatedSequences.set(upper, { current: startSeq });
  }

  // 3. Assign sequential SKUs preserving original order
  const generatedSkus: string[] = [];
  for (const p of prefixes) {
    const upper = p.toUpperCase().trim();
    const alloc = allocatedSequences.get(upper)!;
    generatedSkus.push(`${upper}${alloc.current}`);
    alloc.current++;
  }

  console.log(`[sku] Batch generated ${generatedSkus.length} SKUs across ${prefixCounts.size} prefix(es)`);
  return generatedSkus;
}
