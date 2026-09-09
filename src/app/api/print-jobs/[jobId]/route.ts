import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { connectToPrinterDb, getPrinterModels } from "@/lib/db/printer";
import { handleRoute, notFound, success } from "@/lib/api-handling/api-response";

export const GET = withAuth(
  async (
    _request: NextRequest,
    ctx: { params: Promise<{ jobId: string }> }
  ) => {
    return handleRoute(async () => {
      const { jobId } = await ctx.params;

      if (!jobId) {
        return notFound("Job ID is required");
      }

      const { PrintJob } = await getPrinterModels();

      const job = await PrintJob.findOne({ jobId }).lean();

      if (!job) {
        return notFound(`Print job "${jobId}" not found`);
      }

      return success({ job });
    });
  }
);
