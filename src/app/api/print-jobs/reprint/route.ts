import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { connectToPrinterDb, getPrinterModels } from "@/lib/db/printer";
import { publishPrintJob } from "@/lib/mqtt/publisher";
import {
  generateTsplBatchPayload,
  type TsplItemPayloadInput,
} from "@/lib/printer/tspl";
import { getPrinterById, DEFAULT_PRINTER_ID } from "@/lib/printer/registry";
import { rateLimit, validateCsrf, auditLog, requireClientIp } from "@/lib/security";
import {
  success,
  error,
  forbidden,
  tooManyRequests,
  validationFailed,
  notFound,
  serverError,
} from "@/lib/api-handling/api-response";

const ReprintSchema = z.object({
  jobIds: z
    .array(z.string().trim().min(1, "Job ID cannot be empty"))
    .min(1, "Please select at least one job to reprint")
    .max(500, "Maximum 500 jobs per reprint batch"),
  printerId: z.string().trim().optional(),
});

/**
 * POST /api/print-jobs/reprint
 *
 * Reprints existing print jobs using their ORIGINAL assigned SKUs.
 * NO new SKUs are generated, preserving database consistency and preventing Excel/catalog desync.
 * Uses continuous-stream TSPL batching for smooth, backfeed-free printing.
 */
export const POST = withAuth(async (request: NextRequest, ctx) => {
  const ip = requireClientIp(request);
  const traceId = crypto.randomUUID();

  // 1. Validate CSRF
  if (!validateCsrf(request)) {
    auditLog.emit("CSRF_VALIDATION_FAILED", request, {
      ip,
      traceId,
      context: { endpoint: "/api/print-jobs/reprint" },
    });
    return forbidden();
  }

  // 2. Rate Limiting
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

  // 3. Parse and Validate Request Body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid request body. JSON expected.", 400);
  }

  const parsed = ReprintSchema.safeParse(body);
  if (!parsed.success) {
    return validationFailed(
      parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
    );
  }

  const { jobIds, printerId: requestedPrinterId } = parsed.data;

  // 4. Resolve Target Printer
  const targetPrinterId =
    requestedPrinterId || process.env.MQTT_PRINTER_ID || DEFAULT_PRINTER_ID;
  const targetPrinter = getPrinterById(targetPrinterId);
  if (!targetPrinter) {
    return error(
      `Invalid or disabled printer "${targetPrinterId}". Available printers can be viewed at /api/printers.`,
      400
    );
  }

  try {
    await connectToPrinterDb();
    const { PrintJob } = await getPrinterModels();

    // 5. Query matching jobs from DB (preserving original order requested)
    const existingJobs = await PrintJob.find({ jobId: { $in: jobIds } }).lean();
    if (!existingJobs || existingJobs.length === 0) {
      return notFound("No matching print jobs found for the selected IDs.");
    }

    const jobMap = new Map(existingJobs.map((j) => [j.jobId, j]));
    const orderedJobs = jobIds
      .map((id) => jobMap.get(id))
      .filter((j): j is NonNullable<typeof j> => Boolean(j));

    if (orderedJobs.length === 0) {
      return notFound("None of the requested job IDs could be found.");
    }

    // 6. Build continuous-stream TSPL batch payload reusing existing SKUs
    const tsplPayloadInputs: TsplItemPayloadInput[] = orderedJobs.map((job) => ({
      skuNumber: job.sku,
      designNumber: job.designNumber || undefined,
      grossWeight: job.grossWeight ?? undefined,
      netWeight: job.netWeight ?? undefined,
      stoneWeight: job.stoneWeight ?? undefined,
      metalPurity: job.metalPurity ?? undefined,
      metalType: job.metalType || undefined,
      czWeight: job.reserved1 ?? undefined,
      bsWeight: job.reserved3 ?? undefined,
    }));

    const batchJobId = crypto.randomUUID();
    const batchPayload = generateTsplBatchPayload(tsplPayloadInputs);
    const summarySku =
      orderedJobs.length === 1
        ? orderedJobs[0].sku
        : `${orderedJobs[0].sku}..${orderedJobs[orderedJobs.length - 1].sku} (${orderedJobs.length} reprints)`;

    const foundJobIds = orderedJobs.map((j) => j.jobId);

    // 7. Publish to MQTT printer
    try {
      await publishPrintJob({
        job_id: batchJobId,
        sku: summarySku,
        printer_id: targetPrinter.id,
        payload_type: "TSPL",
        payload: batchPayload,
      });

      // Update print jobs status & increment retryCount
      await PrintJob.updateMany(
        { jobId: { $in: foundJobIds } },
        {
          status: "MQTT_PUBLISHED",
          printerId: targetPrinter.id,
          mqttPublishedAt: new Date(),
          $inc: { retryCount: 1 },
        }
      );

      console.log(
        `[print-jobs/reprint] Successfully republished ${foundJobIds.length} job(s) to ${targetPrinter.id}`
      );

      return success({
        batchId: batchJobId,
        reprinted: foundJobIds.length,
        total: jobIds.length,
        printerId: targetPrinter.id,
        jobIds: foundJobIds,
        skus: orderedJobs.map((j) => j.sku),
      });
    } catch (mqttErr) {
      const errMsg = mqttErr instanceof Error ? mqttErr.message : String(mqttErr);
      console.error(
        `[print-jobs/reprint] MQTT publish failed for batch="${batchJobId}":`,
        errMsg
      );

      await PrintJob.updateMany(
        { jobId: { $in: foundJobIds } },
        {
          status: "MQTT_FAILED",
          lastError: errMsg,
        }
      );

      return serverError(`Printer MQTT dispatch failed: ${errMsg}`);
    }
  } catch (err) {
    console.error("[POST /api/print-jobs/reprint]", err);
    return serverError("Failed to reprint selected jobs.");
  }
});

