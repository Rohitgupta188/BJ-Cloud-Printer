import { NextRequest, after } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { getCatalogModel } from "@/models/catalog/Catalog";
import { connectToPrinterDb, getPrinterModels } from "@/lib/db/printer";
import { generateSkuBatch } from "@/lib/sku/generate";
import { rateLimit, validateCsrf, auditLog } from "@/lib/security";
import { requireClientIp } from "@/lib/security";
import type { PrintJobStatus, PayloadType } from "@/models/printer/PrintJob";
import { publishPrintJob } from "@/lib/mqtt/publisher";
import { uploadPrintJobsToExcel } from "@/lib/drive/excel-upload";
import {
  generateTsplPayload,
  generateTsplBatchPayload,
  type TsplItemPayloadInput,
} from "@/lib/printer/tspl";
import { getPrinterById, DEFAULT_PRINTER_ID } from "@/lib/printer/registry";
import {
  created,
  error,
  forbidden,
  tooManyRequests,
  validationFailed,
  serverError,
} from "@/lib/api-handling/api-response";

const BatchItemSchema = z.object({
  rowId: z.string().trim().optional(),
  prefix: z
    .string()
    .trim()
    .min(1, "Item type is required")
    .max(20, "Item type must be <= 20 characters")
    .regex(/^[A-Z0-9]+$/i, "Item type must be alphanumeric only"),
  designNumber: z.string().trim().optional(),
  imageName: z.string().trim().optional(),
  itemStatus: z.string().trim().default("INSTOCK").optional(),
  grossWeight: z.union([z.number(), z.string().trim()]).optional(),
  netWeight: z.union([z.number(), z.string().trim()]).optional(),
  stoneWeight: z.union([z.number(), z.string().trim()]).optional(),
  metalType: z.string().trim().optional(),
  metalPurity: z.string().trim().optional(),
  collectionLine: z.string().trim().optional(),
  imageUrl: z.string().trim().optional(),
  czWeight: z.union([z.string().trim(), z.number()]).optional(),
  bsWeight: z.union([z.string().trim(), z.number()]).optional(),
  reserved1: z.string().trim().optional(),
  reserved3: z.string().trim().optional(),
});

const BatchPrintJobSchema = z.object({
  printerId: z.string().trim().optional(),
  skipDriveUpload: z.boolean().optional(),
  saveOnly: z.boolean().optional(),
  items: z
    .array(BatchItemSchema)
    .min(1, "At least one item is required")
    .max(500, "Maximum 500 items per batch"),
});

function getDecimalCount(val: string | number | undefined | null): number {
  if (val == null) return 0;
  const s = String(val).trim();
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

export const POST = withAuth(async (request: NextRequest, ctx) => {
  const ip = requireClientIp(request);
  const traceId = crypto.randomUUID();

  if (!validateCsrf(request)) {
    auditLog.emit("CSRF_VALIDATION_FAILED", request, {
      ip,
      traceId,
      context: { endpoint: "/api/print-jobs/batch" },
    });
    return forbidden();
  }

  const rl = await rateLimit.global(ip);
  if (!rl.success) {
    auditLog.emit("RATE_LIMIT_EXCEEDED", request, {
      ip,
      userId: ctx.user.sub,
      traceId,
      context: { limiter: "global", limit: rl.limit, remaining: rl.remaining },
    });
    return tooManyRequests("Too many requests. Please slow down.", rl.headers);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Request body must be valid JSON", 400);
  }

  const parsedBody = BatchPrintJobSchema.safeParse(body);
  if (!parsedBody.success) {
    return validationFailed(
      parsedBody.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
    );
  }

  const { items, saveOnly, skipDriveUpload } = parsedBody.data;

  const requestedPrinterId =
    parsedBody.data.printerId || process.env.MQTT_PRINTER_ID || DEFAULT_PRINTER_ID;
  const printerConfig = getPrinterById(requestedPrinterId);
  if (!printerConfig) {
    return error(
      `Invalid or disabled printer "${requestedPrinterId}". Available printers can be viewed at /api/printers.`,
      400
    );
  }
  const printerId = printerConfig.id;
  const payloadType: PayloadType = "TSPL";

  try {
    const [catalogConn, printerConn] = await Promise.all([
      connectToCatalogDb(),
      connectToPrinterDb(),
    ]);

    // 1. Generate unique sequential SKUs for all items atomically
    const prefixes = items.map((it) => it.prefix.toUpperCase().trim());
    const generatedSkus = await generateSkuBatch({
      catalogConn: catalogConn.connection,
      printerConn: printerConn.connection,
      prefixes,
    });

    const { PrintJob, DesignWeight } = await getPrinterModels();

    // 2. Build individual payloads and PrintJob records
    const jobsToInsert: Array<Record<string, unknown>> = [];
    const tsplPayloadInputs: Array<TsplItemPayloadInput> = [];
    const responseJobs: Array<Record<string, unknown>> = [];
    const designWeightUpserts: Array<any> = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const sku = generatedSkus[i];
      const jobId = crypto.randomUUID();

      const grossWeight = it.grossWeight;
      const netWeight = it.netWeight;
      const stoneWeight = it.stoneWeight;
      const metalType = it.metalType;
      const metalPurity = it.metalPurity;
      const collectionLine = it.collectionLine;
      const imageUrl = it.imageUrl;
      const czWeight = it.czWeight;
      const bsWeight = it.bsWeight;
      const reserved1 = it.reserved1;
      const reserved3 = it.reserved3;
      const designNumber = it.designNumber;
      const imageName = it.imageName;
      const prefix = it.prefix.toUpperCase().trim();

      const cleanMetalPurity = metalPurity
        ? metalPurity.replace(/[kK\s]/g, "").replace(/T$/i, "")
        : undefined;

      const effectiveCzWeight = czWeight ?? reserved1;
      const effectiveBsWeight = bsWeight ?? reserved3;

      const czNum =
        effectiveCzWeight !== undefined && !isNaN(Number(effectiveCzWeight))
          ? Number(effectiveCzWeight)
          : 0;
      const bsNum =
        effectiveBsWeight !== undefined && !isNaN(Number(effectiveBsWeight))
          ? Number(effectiveBsWeight)
          : 0;

      const grossNum =
        grossWeight !== undefined && !isNaN(Number(grossWeight))
          ? Number(grossWeight)
          : undefined;

      const effectiveStoneWeight =
        stoneWeight !== undefined && String(stoneWeight).trim() !== ""
          ? stoneWeight
          : czNum > 0 || bsNum > 0
          ? (() => {
              const maxDec = Math.max(
                getDecimalCount(effectiveCzWeight),
                getDecimalCount(effectiveBsWeight)
              );
              return (czNum + bsNum).toFixed(maxDec);
            })()
          : grossWeight !== undefined &&
            netWeight !== undefined &&
            !isNaN(Number(grossWeight)) &&
            !isNaN(Number(netWeight)) &&
            Number(grossWeight) > Number(netWeight)
          ? (() => {
              const maxDec = Math.max(
                getDecimalCount(grossWeight),
                getDecimalCount(netWeight)
              );
              return Math.max(0, Number(grossWeight) - Number(netWeight)).toFixed(maxDec);
            })()
          : grossWeight;

      const stoneWeightVal =
        effectiveStoneWeight !== undefined && !isNaN(Number(effectiveStoneWeight))
          ? Number(effectiveStoneWeight)
          : undefined;

      const effectiveNetWeight =
        netWeight !== undefined
          ? netWeight
          : grossNum !== undefined
          ? stoneWeightVal !== undefined && stoneWeightVal > 0
            ? (() => {
                const nDec = Math.max(
                  getDecimalCount(grossWeight),
                  getDecimalCount(effectiveStoneWeight)
                );
                return Math.max(0, grossNum - stoneWeightVal).toFixed(nDec);
              })()
            : grossWeight
          : undefined;

      const netNum =
        effectiveNetWeight !== undefined && !isNaN(Number(effectiveNetWeight))
          ? Number(effectiveNetWeight)
          : undefined;

      const payloadInput: TsplItemPayloadInput = {
        skuNumber: sku,
        designNumber,
        grossWeight: grossWeight ?? grossNum,
        netWeight: effectiveNetWeight,
        stoneWeight: effectiveStoneWeight,
        metalPurity: cleanMetalPurity,
        metalType,
        czWeight: effectiveCzWeight,
        bsWeight: effectiveBsWeight,
      };

      const individualPayload = generateTsplPayload(payloadInput);
      tsplPayloadInputs.push(payloadInput);

      const effectiveImageName =
        imageName || (designNumber ? `${designNumber}.jpg` : undefined);

      jobsToInsert.push({
        jobId,
        sku,
        itemType: prefix,
        printerId,
        payloadType,
        payload: individualPayload,
        status: "PENDING" as PrintJobStatus,
        createdBy: ctx.user.sub,
        retryCount: 0,
        designNumber,
        imageName: effectiveImageName,
        itemStatus: "INSTOCK",
        grossWeight: grossNum,
        netWeight: netNum,
        stoneWeight: stoneWeightVal,
        metalType,
        metalPurity: cleanMetalPurity,
        collectionLine,
        imageUrl,
        reserved1: effectiveCzWeight !== undefined ? String(effectiveCzWeight) : undefined,
        reserved3: effectiveBsWeight !== undefined ? String(effectiveBsWeight) : undefined,
      });

      responseJobs.push({
        rowId: it.rowId,
        jobId,
        sku,
        itemType: prefix,
        printerId,
        payloadType,
        status: "PENDING" as PrintJobStatus,
        createdAt: new Date(),
        designNumber,
        grossWeight: grossNum,
        netWeight: netNum,
        stoneWeight: stoneWeightVal,
        metalType,
        metalPurity: cleanMetalPurity,
        collectionLine,
        reserved1: effectiveCzWeight !== undefined ? String(effectiveCzWeight) : undefined,
        reserved3: effectiveBsWeight !== undefined ? String(effectiveBsWeight) : undefined,
      });

      // Prepare DesignWeight storage if applicable
      if (designNumber && effectiveCzWeight !== undefined && String(effectiveCzWeight).trim() !== "") {
        const czStr = String(effectiveCzWeight).trim();
        const normDn = designNumber.trim().toUpperCase();

        designWeightUpserts.push({
          updateOne: {
            filter: { designNumber: normDn },
            update: {
              $set: {
                designNumber: normDn,
                reserved1: czStr,
                ...(effectiveBsWeight !== undefined && String(effectiveBsWeight).trim() !== ""
                  ? { reserved3: String(effectiveBsWeight).trim() }
                  : {}),
                ...(grossNum !== undefined ? { grossWeight: grossNum } : {}),
                ...(netNum !== undefined ? { netWeight: netNum } : {}),
                ...(stoneWeightVal !== undefined ? { stoneWeight: stoneWeightVal } : {}),
                ...(metalType ? { metalType } : {}),
                ...(cleanMetalPurity ? { metalPurity: cleanMetalPurity } : {}),
                ...(effectiveImageName ? { imageName: effectiveImageName } : {}),
                ...(imageUrl ? { imageUrl } : {}),
              },
            },
            upsert: true,
          },
        });
      }
    }

    // 3. Batch insert jobs into MongoDB
    await PrintJob.insertMany(jobsToInsert);
    console.log(`[print-jobs/batch] Saved ${jobsToInsert.length} jobs as PENDING`);

    // 4. Batch upsert DesignWeights if applicable
    if (designWeightUpserts.length > 0) {
      try {
        await DesignWeight.bulkWrite(designWeightUpserts);
      } catch (dwErr) {
        console.error("[print-jobs/batch] Failed to bulk write design weights:", dwErr);
      }
    }

    if (saveOnly) {
      console.log(`[print-jobs/batch] saveOnly requested: ${jobsToInsert.length} jobs saved as PENDING`);
      return created({
        batchId: crypto.randomUUID(),
        jobs: responseJobs,
      });
    }

    // 5. Generate continuous-stream TSPL batch payload and publish ONE MQTT job
    const batchJobId = crypto.randomUUID();
    const batchPayload = generateTsplBatchPayload(tsplPayloadInputs);
    const batchSummarySku =
      generatedSkus.length === 1
        ? generatedSkus[0]
        : `${generatedSkus[0]}..${generatedSkus[generatedSkus.length - 1]} (${generatedSkus.length} tags)`;

    let finalStatus: PrintJobStatus = "PENDING";
    const jobIds = jobsToInsert.map((j) => j.jobId as string);

    try {
      await publishPrintJob({
        job_id: batchJobId,
        sku: batchSummarySku,
        printer_id: printerId,
        payload_type: payloadType,
        payload: batchPayload,
      });

      await PrintJob.updateMany(
        { jobId: { $in: jobIds } },
        { status: "MQTT_PUBLISHED", mqttPublishedAt: new Date() }
      );

      finalStatus = "MQTT_PUBLISHED";
      responseJobs.forEach((j) => (j.status = "MQTT_PUBLISHED"));
      console.log(`[print-jobs/batch] MQTT_PUBLISHED batchJobId="${batchJobId}" tags=${jobsToInsert.length}`);

      // 6. Optional Drive Excel upload in background
      if (!skipDriveUpload) {
        after(async () => {
          try {
            await uploadPrintJobsToExcel(
              jobsToInsert.map((j) => ({
                sku: j.sku as string,
                rfid: j.sku as string,
                designNumber: j.designNumber as string | undefined,
                imageName: j.imageName as string | undefined,
                itemStatus: j.itemStatus as string | undefined,
                itemType: j.itemType as string | undefined,
                metalType: j.metalType as string | undefined,
                metalPurity: j.metalPurity as string | undefined,
                grossWeight: j.grossWeight as number | undefined,
                netWeight: j.netWeight as number | undefined,
                stoneWeight: j.stoneWeight as number | undefined,
                collectionLine: j.collectionLine as string | undefined,
                reserved1: j.reserved1 as string | undefined,
                reserved3: j.reserved3 as string | undefined,
                printerId: j.printerId as string,
                status: "MQTT_PUBLISHED" as PrintJobStatus,
                createdAt: new Date(),
                createdBy: ctx.user.sub,
              }))
            );
          } catch (driveErr) {
            console.error(`[print-jobs/batch] Drive upload failed for batch="${batchJobId}":`, driveErr);
          }
        });
      }
    } catch (mqttErr) {
      const errMsg = mqttErr instanceof Error ? mqttErr.message : String(mqttErr);
      console.error(`[print-jobs/batch] MQTT publish failed for batch="${batchJobId}":`, mqttErr);

      await PrintJob.updateMany(
        { jobId: { $in: jobIds } },
        { status: "MQTT_FAILED", lastError: errMsg }
      );

      finalStatus = "MQTT_FAILED";
      responseJobs.forEach((j) => (j.status = "MQTT_FAILED"));
    }

    return created({
      batchId: batchJobId,
      status: finalStatus,
      jobs: responseJobs,
    });
  } catch (err) {
    console.error("[POST /api/print-jobs/batch]", err);
    return serverError("Failed to process batch print jobs");
  }
});
