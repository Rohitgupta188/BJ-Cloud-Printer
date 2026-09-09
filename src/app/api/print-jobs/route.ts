import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { connectToCatalogDb } from "@/lib/db/catalog";
import { connectToPrinterDb, getPrinterModels } from "@/lib/db/printer";
import { generateSku } from "@/lib/sku/generate";
import { rateLimit, validateCsrf, applySecurityHeaders, auditLog } from "@/lib/security";
import { requireClientIp } from "@/lib/security";
import type { PrintJobStatus } from "@/models/printer/PrintJob";

const VALID_STATUSES = [
  "PENDING",
  "MQTT_PUBLISHED",
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
  metalType?: string;
  metalPurity?: string;
}): string {
  const gw = data.grossWeight != null ? `${data.grossWeight}g` : "";
  const nw = data.netWeight   != null ? `${data.netWeight}g`   : "";
  const purity = data.metalPurity ?? "";
  const dn = data.designNumber ?? "";

  return [
    `SIZE 40 mm, 30 mm`,
    `GAP 3 mm, 0 mm`,
    `DIRECTION 0`,
    `CLS`,
    `TEXT 10,5,"3",0,1,1,"${sku}"`,
    dn     ? `TEXT 10,30,"2",0,1,1,"${dn}"` : "",
    gw     ? `TEXT 10,50,"2",0,1,1,"GW:${gw}  NW:${nw}"` : "",
    purity ? `TEXT 10,68,"2",0,1,1,"${purity}"` : "",
    `BARCODE 10,88,"128",40,1,0,2,2,"${sku}"`,
    `PRINT 1`,
  ].filter(Boolean).join("\n");
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
        return applySecurityHeaders(
          NextResponse.json(
            {
              success: false,
              error: `Invalid status "${rawStatus}". Must be one of: ${VALID_STATUSES.join(", ")}.`,
            },
            { status: 400 }
          )
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

    return applySecurityHeaders(
      NextResponse.json(
        { success: true, data: { jobs, total, page, limit, pages: Math.ceil(total / limit) } },
        { status: 200 }
      )
    );
  } catch (err) {
    console.error("[GET /api/print-jobs]", err);
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "Internal server error" },
        { status: 500 }
      )
    );
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
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "CSRF validation failed" },
        { status: 403 }
      )
    );
  }

  const rl = await rateLimit.global(ip);
  if (!rl.success) {
    auditLog.emit("RATE_LIMIT_EXCEEDED", request, {
      ip,
      userId: ctx.user.sub,
      traceId,
      context: { limiter: "global", limit: rl.limit, remaining: rl.remaining },
    });
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "Too many requests. Please slow down." },
        { status: 429, headers: rl.headers }
      )
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "Invalid request body" },
        { status: 400 }
      )
    );
  }

  const parsed = CreatePrintJobSchema.safeParse(body);
  if (!parsed.success) {
    return applySecurityHeaders(
      NextResponse.json(
        {
          success: false,
          error: "Validation failed",
          details: parsed.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 422 }
      )
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
  } = parsed.data;

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

    // Step 2: Build TSPL payload internally.
    const payload = buildTsplPayload(sku, {
      designNumber,
      grossWeight,
      netWeight,
      metalType,
      metalPurity,
    });

    // Step 3: Save print job to BJ-Printer DB.
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
      // Item metadata
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

    // Phase 3 hook: MQTT publish goes here after job is saved.

    return NextResponse.json(
      {
        success: true,
        data: {
          job: {
            jobId: job.jobId,
            sku: job.sku,
            printerId: job.printerId,
            payloadType: job.payloadType,
            status: job.status,
            createdAt: job.createdAt,
            designNumber: job.designNumber,
            grossWeight: job.grossWeight,
            netWeight: job.netWeight,
            stoneWeight: job.stoneWeight,
            metalType: job.metalType,
            metalPurity: job.metalPurity,
            collectionLine: job.collectionLine,
          },
        },
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /api/print-jobs]", err);
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "Failed to create print job" },
        { status: 500 }
      )
    );
  }
});
