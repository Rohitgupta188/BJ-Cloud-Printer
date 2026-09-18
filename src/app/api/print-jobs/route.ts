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

function buildZplPayload(sku: string, data: {
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

  // Label: 90 mm × 70 mm @ 300 dpi ≈ 1063 × 827 dots
  // All fields rotated 180° (^FWI) to match original orientation.
  return [
    `^XA`,
    `^PW1063`,                                          // label width  (90 mm)
    `^LL0827`,                                          // label length (70 mm)
    `^FWI`,                                             // rotate all fields 180°
    `^CI28`,                                            // UTF-8 codepage

    // --- Right column: design/weight labels (mirrored from TSPL coords) ---
    `^FO380,105^A0,25,25^FDD.No: ${f(data.designNumber)}^FS`,
    `^FO380,85^A0,25,25^FDG.Wt: ${f(data.grossWeight, "g")}^FS`,
    `^FO380,65^A0,25,25^FDS Wt: ${f(data.stoneWeight, "g")}^FS`,
    `^FO380,45^A0,25,25^FDN Wt: ${f(data.netWeight, "g")}^FS`,
    `^FO300,45^A0,25,25^FDKT: ${f(data.metalPurity)}^FS`,

    // --- QR Code ---
    `^FO150,100^BQN,2,3^FDMM,A${sku}^FS`,

    // --- Left column: duplicate weight + purity/metal ---
    `^FO230,85^A0,25,25^FDG.Wt: ${f(data.grossWeight, "g")}^FS`,
    `^FO230,65^A0,25,25^FDN Wt: ${f(data.netWeight, "g")}^FS`,
    `^FO230,45^A0,25,25^FDKT: ${f(data.metalPurity)}^FS`,
    `^FO180,45^A0,25,25^FD${f(data.metalType)}^FS`,

    // --- Large design/weight header ---
    `^FO565,42^A0,45,45^FD${f(data.designNumber)}/${f(data.grossWeight, "g")}^FS`,

    `^PQ1,0,1,Y`,                                       // print 1 copy
    `^XZ`,
  ].join("\n");
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
  const payloadType = "ZPL" as const;

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

    const payload = buildZplPayload(sku, {
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
