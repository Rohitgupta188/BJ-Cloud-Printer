import { NextRequest, after } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;
import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
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
  grossWeight:    z.number().min(0).optional(),
  netWeight:      z.number().min(0).optional(),
  stoneWeight:    z.number().min(0).optional(),
  metalType:      z.string().trim().optional(),
  metalPurity:    z.string().trim().optional(),
  collectionLine: z.string().trim().optional(),
  imageUrl:       z.string().trim().optional(),
  czWeight:       z.union([z.string().trim(), z.number()]).optional(),
  bsWeight:       z.union([z.string().trim(), z.number()]).optional(),
  reserved1:      z.string().trim().optional(),
  reserved3:      z.string().trim().optional(),
});

function generateTsplPayload(item: {
  skuNumber: string;
  designNumber?: string;
  grossWeight?: string | number;
  netWeight?: string | number;
  stoneWeight?: string | number;
  metalPurity?: string | number;
  metalType?: string;
  czWeight?: string | number;
  bsWeight?: string | number;
}): string {
  const dNo = item.designNumber ?? "";
  const gWt = item.grossWeight !== undefined ? String(item.grossWeight) : "";
  const nWt = item.netWeight !== undefined ? String(item.netWeight) : "";
  const sWt = item.stoneWeight !== undefined ? String(item.stoneWeight) : "";
  const czWt = item.czWeight !== undefined ? String(item.czWeight) : "";
  const bsWt = item.bsWeight !== undefined ? String(item.bsWeight) : "";
  const purity = item.metalPurity !== undefined ? String(item.metalPurity) : "";
  const metal = item.metalType ?? "Y";
  const sku = item.skuNumber ?? "";

  const lines = [
    "SIZE 90 mm, 70 mm",
    "DIRECTION 0,0",
    "REFERENCE 0,0",
    "OFFSET 0 mm",
    "SET PEEL OFF",
    "SET CUTTER OFF",
    "SET PARTIAL_CUTTER OFF",
    "SET TEAR ON",
    "CLS",
    "CODEPAGE 1252",
    `TEXT 380,105,"ROMAN.TTF",180,1,6,"D.No: ${dNo}"`,
    `TEXT 380,85,"ROMAN.TTF",180,1,6,"G.Wt: ${gWt}"`,
    `TEXT 300,85,"ROMAN.TTF",180,1,6,"CZ: ${czWt}"`,
    `TEXT 380,65,"ROMAN.TTF",180,1,6,"S Wt: ${sWt}"`,
    `TEXT 380,45,"ROMAN.TTF",180,1,6,"N Wt: ${nWt}"`,
    `TEXT 300,45,"ROMAN.TTF",180,1,6,"KT: ${purity}"`,
    `TEXT 300,65,"ROMAN.TTF",180,1,6,"BS: ${bsWt}"`,
    `QRCODE 150,100,H,3,A,180,M2,S7,"${sku}"`,
    `TEXT 230,85,"ROMAN.TTF",180,1,6,"G.Wt: ${gWt}"`,
    `TEXT 230,65,"ROMAN.TTF",180,1,6,"N Wt: ${nWt}"`,
    `TEXT 565,42,"0",180,9,9,"${dNo}/${gWt}"`,
    `TEXT 230,45,"ROMAN.TTF",180,1,6,"KT: ${purity}"`,
    `TEXT 180,45,"ROMAN.TTF",180,1,6,"${metal}"`,
    "PRINT 1,1",
    ""
  ];

  return lines.join("\r\n");
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

  const printerId = process.env.MQTT_PRINTER_ID ?? "mumbai-01";
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
      effectiveCzWeight !== undefined && !isNaN(Number(effectiveCzWeight));
    const hasBs =
      effectiveBsWeight !== undefined && !isNaN(Number(effectiveBsWeight));

    const effectiveStoneWeight =
      stoneWeight !== undefined
        ? stoneWeight
        : hasCz || hasBs
          ? Math.round((czNum + bsNum) * 1000) / 1000
          : undefined;

    const effectiveNetWeight =
      netWeight !== undefined
        ? netWeight
        : grossWeight !== undefined
          ? effectiveStoneWeight !== undefined
            ? Math.round((grossWeight - Number(effectiveStoneWeight)) * 1000) / 1000
            : grossWeight
          : undefined;

    const payload = generateTsplPayload({
      skuNumber: sku,
      designNumber,
      grossWeight,
      netWeight: effectiveNetWeight,
      stoneWeight: effectiveStoneWeight,
      metalPurity,
      metalType,
      czWeight: effectiveCzWeight,
      bsWeight: effectiveBsWeight,
    });

    const jobId = crypto.randomUUID();
    const { PrintJob } = await getPrinterModels();

    const job = await PrintJob.create({
      jobId,
      sku,
      printerId,
      payloadType,
      payload,
      status: "PENDING",
      createdBy: ctx.user.sub,
      retryCount: 0,
      designNumber,
      grossWeight,
      netWeight: effectiveNetWeight,
      stoneWeight: effectiveStoneWeight,
      metalType,
      metalPurity,
      collectionLine,
      imageUrl,
      reserved1: effectiveCzWeight !== undefined ? String(effectiveCzWeight) : undefined,
      reserved3: effectiveBsWeight !== undefined ? String(effectiveBsWeight) : undefined,
    });

    console.log(`[print-jobs] Job saved: jobId="${jobId}" sku="${sku}" status="PENDING"`);

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
      after(async () => {
        try {
          await uploadPrintJobsToExcel([{
            sku,
            rfid: sku,
            designNumber,
            metalType,
            metalPurity,
            grossWeight,
            netWeight: effectiveNetWeight,
            stoneWeight: effectiveStoneWeight,
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
