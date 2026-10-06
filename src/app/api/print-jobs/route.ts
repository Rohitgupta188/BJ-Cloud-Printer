import { NextRequest, after } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;
import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { getCatalogModel } from "@/models/catalog/Catalog";
import { connectToPrinterDb, getPrinterModels } from "@/lib/db/printer";
import { generateSku } from "@/lib/sku/generate";
import { rateLimit, validateCsrf, auditLog } from "@/lib/security";
import { requireClientIp } from "@/lib/security";
import type { PrintJobStatus } from "@/models/printer/PrintJob";
import { publishPrintJob } from "@/lib/mqtt/publisher";
import { uploadPrintJobsToExcel } from "@/lib/drive/excel-upload";
import {
  success,
  created,
  error,
  forbidden,
  tooManyRequests,
  validationFailed,
  serverError,
} from "@/lib/api-handling/api-response";

const VALID_STATUSES = [
  "PENDING",
  "MQTT_PUBLISHED",
  "MQTT_FAILED",
  "AGENT_RECEIVED",
  "COMPLETED",
  "FAILED",
  "UNKNOWN",
] as const satisfies PrintJobStatus[];

const StatusQuerySchema = z.enum(VALID_STATUSES);

const CreatePrintJobSchema = z.object({
  prefix: z
    .string()
    .trim()
    .min(1, "Item type is required")
    .max(20, "Item type must be ≤ 20 characters")
    .regex(/^[A-Z0-9]+$/i, "Item type must be alphanumeric only"),

  designNumber:   z.string().trim().optional(),
  imageName:      z.string().trim().optional(),
  itemStatus:     z.string().trim().default("INSTOCK").optional(),
  grossWeight:    z.union([z.number(), z.string().trim()]).optional(),
  netWeight:      z.union([z.number(), z.string().trim()]).optional(),
  stoneWeight:    z.union([z.number(), z.string().trim()]).optional(),
  metalType:      z.string().trim().optional(),
  metalPurity:    z.string().trim().optional(),
  collectionLine: z.string().trim().optional(),
  imageUrl:       z.string().trim().optional(),
  czWeight:       z.union([z.string().trim(), z.number()]).optional(),
  bsWeight:       z.union([z.string().trim(), z.number()]).optional(),
  reserved1:      z.string().trim().optional(),
  reserved3:      z.string().trim().optional(),
  printerId:      z.string().trim().optional(),
  skipDriveUpload: z.boolean().optional(),
  saveOnly:       z.boolean().optional(),
});

import { generateTsplPayload } from "@/lib/printer/tspl";
import { getPrinterById, DEFAULT_PRINTER_ID } from "@/lib/printer/registry";

function getDecimalCount(val: string | number | undefined | null): number {
  if (val == null) return 0;
  const s = String(val).trim();
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}


export const GET = withAuth(async (request: NextRequest) => {
  try {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10)));
    const rawStatus = url.searchParams.get("status");

    let statusFilter: PrintJobStatus | undefined;
    if (rawStatus !== null) {
      const parsed = StatusQuerySchema.safeParse(rawStatus);
      if (!parsed.success) {
        return error(
          `Invalid status "${rawStatus}". Must be one of: ${VALID_STATUSES.join(", ")}.`,
          400
        );
      }
      statusFilter = parsed.data;
    }

    const { PrintJob } = await getPrinterModels();

    const filter: Record<string, unknown> = {};
    if (statusFilter) filter.status = statusFilter;

    const [jobs, total] = await Promise.all([
      PrintJob.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PrintJob.countDocuments(filter),
    ]);

    return success({ jobs, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[GET /api/print-jobs]", err);
    return serverError();
  }
});

export const POST = withAuth(async (request: NextRequest, ctx) => {
  const ip = requireClientIp(request);
  const traceId = crypto.randomUUID();

  if (!validateCsrf(request)) {
    auditLog.emit("CSRF_VALIDATION_FAILED", request, {
      ip,
      traceId,
      context: { endpoint: "/api/print-jobs" },
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
    return error("Invalid request body", 400);
  }

  const parsedBody = CreatePrintJobSchema.safeParse(body);
  if (!parsedBody.success) {
    return validationFailed(
      parsedBody.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
    );
  }

  const {
    prefix,
    designNumber,
    imageName,
    itemStatus,
    grossWeight,
    netWeight,
    stoneWeight,
    metalType,
    metalPurity,
    collectionLine,
    imageUrl,
    czWeight,
    bsWeight,
    reserved1,
    reserved3,
  } = parsedBody.data;

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
  const payloadType = "TSPL" as const;

  try {
    const [catalogConn, printerConn] = await Promise.all([
      connectToCatalogDb(),
      connectToPrinterDb(),
    ]);

    // Always generate a brand new unique SKU for every print job (new or repeat)
    const sku = await generateSku({
      catalogConn: catalogConn.connection,
      printerConn: printerConn.connection,
      prefix: prefix.toUpperCase(),
    });
    console.log(`[print-jobs] New SKU generated: "${sku}" for user="${ctx.user.sub}"`);

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
    const hasCz =
      effectiveCzWeight !== undefined &&
      !isNaN(Number(effectiveCzWeight)) &&
      String(effectiveCzWeight).trim() !== "";
    const hasBs =
      effectiveBsWeight !== undefined &&
      !isNaN(Number(effectiveBsWeight)) &&
      String(effectiveBsWeight).trim() !== "";

    const grossNum =
      grossWeight !== undefined && !isNaN(Number(grossWeight))
        ? Number(grossWeight)
        : undefined;

    const stoneNum =
      stoneWeight !== undefined && !isNaN(Number(stoneWeight))
        ? Number(stoneWeight)
        : undefined;

    const effectiveStoneWeight =
      stoneWeight !== undefined
        ? stoneWeight
        : hasCz && !hasBs
          ? effectiveCzWeight
          : !hasCz && hasBs
            ? effectiveBsWeight
            : hasCz && hasBs
              ? (() => {
                  const sDec = Math.max(
                    getDecimalCount(effectiveCzWeight),
                    getDecimalCount(effectiveBsWeight)
                  );
                  return (czNum + bsNum).toFixed(sDec);
                })()
              : undefined;

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

    const payload = generateTsplPayload({
      skuNumber: sku,
      designNumber,
      grossWeight: grossWeight ?? grossNum,
      netWeight: effectiveNetWeight,
      stoneWeight: effectiveStoneWeight,
      metalPurity,
      metalType,
      czWeight: effectiveCzWeight,
      bsWeight: effectiveBsWeight,
    });

    const jobId = crypto.randomUUID();
    const { PrintJob, DesignWeight } = await getPrinterModels();

    const effectiveImageName = imageName || (designNumber ? `${designNumber}.jpg` : undefined);

    const job = await PrintJob.create({
      jobId,
      sku,
      itemType: prefix,
      printerId,
      payloadType,
      payload,
      status: "PENDING",
      createdBy: ctx.user.sub,
      retryCount: 0,
      designNumber,
      imageName: effectiveImageName,
      itemStatus: "INSTOCK",
      grossWeight: grossNum,
      netWeight: netNum,
      stoneWeight: stoneWeightVal,
      metalType,
      metalPurity,
      collectionLine,
      imageUrl,
      reserved1: effectiveCzWeight !== undefined ? String(effectiveCzWeight) : undefined,
      reserved3: effectiveBsWeight !== undefined ? String(effectiveBsWeight) : undefined,
    });

    console.log(`[print-jobs] Job saved: jobId="${jobId}" sku="${sku}" status="PENDING"`);

    // 1. Store CZ weight & design metadata in dedicated DesignWeight model (BJ-Printer DB)
    if (designNumber && effectiveCzWeight !== undefined && String(effectiveCzWeight).trim() !== "") {
      const czStr = String(effectiveCzWeight).trim();
      const normDn = designNumber.trim().toUpperCase();

      try {
        await DesignWeight.updateOne(
          { designNumber: normDn },
          {
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
              ...(metalPurity ? { metalPurity } : {}),
              ...(effectiveImageName ? { imageName: effectiveImageName } : {}),
              ...(imageUrl ? { imageUrl } : {}),
            },
          },
          { upsert: true }
        );
      } catch (dwErr) {
        console.error("[print-jobs] Failed to save design weight in printer DB:", dwErr);
      }

      // 2. Update main catalog ONLY if the product and its full data already exists — never insert/upsert stub records
      try {
        const escapedDn = designNumber.trim().replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
        const Catalog = getCatalogModel(catalogConn.connection);
        const existing = await Catalog.findOne({
          $or: [
            { designNumber: { $regex: `^${escapedDn}$`, $options: "i" } },
            { imageName: { $regex: `^${escapedDn}(\\.jpg)?$`, $options: "i" } },
          ],
        }).select({ reserved1: 1, sku: 1, itemStatus: 1 }).lean();

        // Only update if existing full catalog item (not a stub) and reserved1 is not yet present
        if (existing && (existing.sku || existing.itemStatus) && !existing.reserved1) {
          await Catalog.updateMany(
            {
              $or: [
                { designNumber: { $regex: `^${escapedDn}$`, $options: "i" } },
                { imageName: { $regex: `^${escapedDn}(\\.jpg)?$`, $options: "i" } },
              ],
            },
            { $set: { reserved1: czStr } }
          );
        }
      } catch (czErr) {
        console.error("[print-jobs] Failed to update existing catalog item:", czErr);
      }
    }

    if (parsedBody.data.saveOnly) {
      console.log(`[print-jobs] saveOnly requested: jobId="${jobId}" sku="${sku}" saved as PENDING`);
      return created({
        job: {
          jobId:         job.jobId,
          sku:           job.sku,
          itemType:      prefix,
          printerId:     job.printerId,
          payloadType:   job.payloadType,
          status:        "PENDING",
          createdAt:     job.createdAt,
          designNumber:  job.designNumber,
          grossWeight:   job.grossWeight,
          netWeight:     job.netWeight,
          stoneWeight:   job.stoneWeight,
          metalType:     job.metalType,
          metalPurity:   job.metalPurity,
          collectionLine:job.collectionLine,
          reserved1:     job.reserved1,
          reserved3:     job.reserved3,
        },
      });
    }

    let finalStatus: PrintJobStatus = "PENDING";

    try {
      await publishPrintJob({
        job_id:       jobId,
        sku,
        printer_id:   printerId,
        payload_type: payloadType,
        payload,
      });

      await PrintJob.updateOne(
        { jobId },
        { status: "MQTT_PUBLISHED", mqttPublishedAt: new Date() }
      );

      finalStatus = "MQTT_PUBLISHED";
      console.log(`[print-jobs] MQTT_PUBLISHED jobId="${jobId}" sku="${sku}"`);

      // ── Drive Excel upload (Vercel Serverless background task) ────────────
      // Using after() guarantees Vercel keeps the function alive until the Drive
      // upload finishes, while returning the print response to the user instantly.
      if (!parsedBody.data.skipDriveUpload) {
        after(async () => {
          try {
            await uploadPrintJobsToExcel([{
              sku,
              rfid: sku,
              designNumber,
              imageName: effectiveImageName,
              itemStatus: "INSTOCK",
              itemType: prefix,
              metalType,
              metalPurity,
              grossWeight: grossNum,
              netWeight: netNum,
              stoneWeight: stoneWeightVal,
              collectionLine,
              reserved1: effectiveCzWeight !== undefined ? String(effectiveCzWeight) : undefined,
              reserved3: effectiveBsWeight !== undefined ? String(effectiveBsWeight) : undefined,
              printerId,
              status:    "MQTT_PUBLISHED",
              createdAt: new Date(),
              createdBy: ctx.user.sub,
            }]);
          } catch (driveErr) {
            console.error(`[print-jobs] Drive upload failed for jobId="${jobId}":`, driveErr);
          }
        });
      }

    } catch (mqttErr) {
      const errMsg = mqttErr instanceof Error ? mqttErr.message : String(mqttErr);
      console.error(`[print-jobs] MQTT publish failed for jobId="${jobId}":`, mqttErr);

      await PrintJob.updateOne(
        { jobId },
        { status: "MQTT_FAILED", lastError: errMsg }
      );

      finalStatus = "MQTT_FAILED";
    }

    return created({
      job: {
        jobId:         job.jobId,
        sku:           job.sku,
        printerId:     job.printerId,
        payloadType:   job.payloadType,
        status:        finalStatus,
        createdAt:     job.createdAt,
        designNumber:  job.designNumber,
        grossWeight:   job.grossWeight,
        netWeight:     job.netWeight,
        stoneWeight:   job.stoneWeight,
        metalType:     job.metalType,
        metalPurity:   job.metalPurity,
        collectionLine:job.collectionLine,
        reserved1:     job.reserved1,
        reserved3:     job.reserved3,
      },
    });
  } catch (err) {
    console.error("[POST /api/print-jobs]", err);
    return serverError("Failed to create print job");
  }
});
