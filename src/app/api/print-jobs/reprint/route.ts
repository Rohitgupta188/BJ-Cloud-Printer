import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { getPrinterModels } from "@/lib/db/printer";
import { publishPrintJob } from "@/lib/mqtt/publisher";
import { generateTsplPayload } from "@/lib/printer/tspl";
import { validateCsrf, requireClientIp, auditLog } from "@/lib/security";
import {
  success,
  error,
  forbidden,
  validationFailed,
  serverError,
  notFound,
} from "@/lib/api-handling/api-response";
import { getPrinterById, DEFAULT_PRINTER_ID } from "@/lib/printer/registry";

const ReprintSchema = z.object({
  jobIds: z
    .array(z.string().trim().min(1, "Job ID cannot be empty"))
    .min(1, "Please select at least one job to print"),
  printerId: z.string().trim().optional(),
});

export const POST = withAuth(async (request: NextRequest, ctx) => {
  const ip = requireClientIp(request);
  const traceId = crypto.randomUUID();

  if (!validateCsrf(request)) {
    auditLog.emit("CSRF_VALIDATION_FAILED", request, {
      ip,
      traceId,
      context: { endpoint: "/api/print-jobs/reprint" },
    });
    return forbidden();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid request body", 400);
  }

  const parsed = ReprintSchema.safeParse(body);
  if (!parsed.success) {
    return validationFailed(
      parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
    );
  }

  const { jobIds, printerId: requestedPrinterId } = parsed.data;

  // If a printer was explicitly requested, validate it against the registry
  if (requestedPrinterId && !getPrinterById(requestedPrinterId)) {
    return error(
      `Invalid or disabled printer "${requestedPrinterId}".`,
      400
    );
  }

  try {
    const { PrintJob } = await getPrinterModels();

    const jobs = await PrintJob.find({ jobId: { $in: jobIds } });
    if (!jobs || jobs.length === 0) {
      return notFound("No matching print jobs found for the selected IDs");
    }

    let successCount = 0;
    const errors: { jobId: string; sku: string; error: string }[] = [];

    for (const job of jobs) {
      try {
        let payload = job.payload;
        if (!payload || !payload.trim()) {
          payload = generateTsplPayload({
            skuNumber: job.sku,
            designNumber: job.designNumber || undefined,
            grossWeight: job.grossWeight ?? undefined,
            netWeight: job.netWeight ?? undefined,
            stoneWeight: job.stoneWeight ?? undefined,
            metalPurity: job.metalPurity ?? undefined,
            metalType: job.metalType || undefined,
            czWeight: job.reserved1 ?? undefined,
            bsWeight: job.reserved3 ?? undefined,
          });
        }

        // Determine target printer: explicit requested printer, or job's original printer, or fallback default
        const candidatePrinterId = requestedPrinterId || job.printerId || DEFAULT_PRINTER_ID;
        const targetPrinter = getPrinterById(candidatePrinterId) || getPrinterById(DEFAULT_PRINTER_ID)!;

        await publishPrintJob({
          job_id: job.jobId,
          sku: job.sku,
          printer_id: targetPrinter.id,
          payload_type: (job.payloadType as "TSPL" | "ZPL") || "TSPL",
          payload,
        });

        await PrintJob.updateOne(
          { jobId: job.jobId },
          {
            status: "MQTT_PUBLISHED",
            printerId: targetPrinter.id,
            mqttPublishedAt: new Date(),
            $inc: { retryCount: 1 },
          }
        );

        successCount++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[reprint] Failed for jobId="${job.jobId}":`, errMsg);

        await PrintJob.updateOne(
          { jobId: job.jobId },
          {
            status: "MQTT_FAILED",
            lastError: errMsg,
          }
        );

        errors.push({ jobId: job.jobId, sku: job.sku, error: errMsg });
      }
    }

    return success({
      reprinted: successCount,
      total: jobs.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("[POST /api/print-jobs/reprint]", err);
    return serverError("Failed to reprint selected jobs");
  }
});
