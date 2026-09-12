import { NextRequest } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { connectToPrinterDb, getPrinterModels } from "@/lib/db/printer";
import { generateSku } from "@/lib/sku/generate";
import { rateLimit, validateCsrf, auditLog } from "@/lib/security";
import { requireClientIp } from "@/lib/security";
import type { PrintJobStatus } from "@/models/printer/PrintJob";
import { publishPrintJob } from "@/lib/mqtt/publisher";
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
});

function buildTsplPayload(sku: string, data: {
  designNumber?: string;
  grossWeight?: number;
  netWeight?: number;
  stoneWeight?: number;
  metalType?: string;
  metalPurity?: string;
}): string {
  // Helper: format value with optional suffix, or empty string if absent
  const f = (v: string | number | undefined, suffix = "") =>
    v != null && v !== "" ? `${v}${suffix}` : "";

  return [
    `SIZE 90 mm, 70 mm`,
    `DIRECTION 0,0`,
    `REFERENCE 0,0`,
    `OFFSET 0 mm`,
    `SET PEEL OFF`,
    `SET CUTTER OFF`,
    `SET PARTIAL_CUTTER OFF`,
    `SET TEAR ON`,
    `CLS`,
    `CODEPAGE 1252`,
    `TEXT 380,105,"ROMAN.TTF",180,1,6,"D.No: ${f(data.designNumber)}"`,
    `TEXT 380,85,"ROMAN.TTF",180,1,6,"G.Wt: ${f(data.grossWeight, "g")}"`,
    `TEXT 380,65,"ROMAN.TTF",180,1,6,"S Wt: ${f(data.stoneWeight, "g")}"`,
    `TEXT 380,45,"ROMAN.TTF",180,1,6,"N Wt: ${f(data.netWeight, "g")}"`,
    `TEXT 300,45,"ROMAN.TTF",180,1,6,"KT: ${f(data.metalPurity)}"`,
    `QRCODE 150,100,H,3,A,180,M2,S7,"${sku}"`,
    `TEXT 230,85,"ROMAN.TTF",180,1,6,"G.Wt: ${f(data.grossWeight, "g")}"`,
    `TEXT 230,65,"ROMAN.TTF",180,1,6,"N Wt: ${f(data.netWeight, "g")}"`,
    `TEXT 565,42,"0",180,9,9,"${f(data.designNumber)}/${f(data.grossWeight, "g")}"`,
    `TEXT 230,45,"ROMAN.TTF",180,1,6,"KT: ${f(data.metalPurity)}"`,
    `TEXT 180,45,"ROMAN.TTF",180,1,6,"${f(data.metalType)}"`,
    `PRINT 1,1`,
  ].join("\r\n");
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
  } = parsedBody.data;

  const printerId = process.env.MQTT_PRINTER_ID ?? "mumbai-01";
  const payloadType = "TSPL" as const;

  try {
    const [catalogConn, printerConn] = await Promise.all([
      connectToCatalogDb(),
      connectToPrinterDb(),
    ]);

    const sku = await generateSku({
      catalogConn: catalogConn.connection,
      printerConn: printerConn.connection,
      prefix: prefix.toUpperCase(),
    });

    console.log(`[print-jobs] SKU generated: "${sku}" for user="${ctx.user.sub}"`);

    const payload = buildTsplPayload(sku, {
      designNumber,
      grossWeight,
      netWeight,
      stoneWeight,
      metalType,
      metalPurity,
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
      netWeight,
      stoneWeight,
      metalType,
      metalPurity,
      collectionLine,
      imageUrl,
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
      },
    });
  } catch (err) {
    console.error("[POST /api/print-jobs]", err);
    return serverError("Failed to create print job");
  }
});
