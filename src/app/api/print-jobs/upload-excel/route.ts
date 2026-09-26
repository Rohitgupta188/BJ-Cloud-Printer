import { NextRequest } from "next/server";
export const runtime = "nodejs";
export const maxDuration = 60;
import { withAuth } from "@/lib/auth";
import { uploadExcelBufferToDrive, uploadPrintJobsToExcel, type PrintJobRecord } from "@/lib/drive/excel-upload";
import { success, error, serverError } from "@/lib/api-handling/api-response";

export const POST = withAuth(async (request: NextRequest) => {
  try {
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      let fileName = (formData.get("fileName") as string) || "BJ_Print_Batch.xlsx";

      if (!file) {
        return error("No file provided in form data", 400);
      }

      if (!fileName.endsWith(".xlsx")) fileName = `${fileName}.xlsx`;

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const fileId = await uploadExcelBufferToDrive(buffer, fileName);
      return success({ fileId, fileName });
    }

    // JSON fallback
    const body = await request.json();
    const { fileName, records } = body as { fileName?: string; records?: PrintJobRecord[] };

    if (!records || records.length === 0) {
      return error("No records provided", 400);
    }

    const fileId = await uploadPrintJobsToExcel(records, fileName);
    return success({ fileId, fileName: fileName || "BJ_Print_Batch.xlsx" });
  } catch (err: unknown) {
    const anyErr = err as {
      code?: number;
      response?: { data?: { error?: { message?: string; errors?: Array<{ reason?: string }> } } };
      message?: string;
    };

    const isQuotaError =
      anyErr?.response?.data?.error?.errors?.some((e) => e.reason === "storageQuotaExceeded") ||
      (typeof anyErr?.message === "string" && anyErr.message.includes("Service Accounts do not have storage quota"));

    if (isQuotaError) {
      console.warn(
        "[POST /api/print-jobs/upload-excel] Service Account quota limit: Target folder is in personal My Drive instead of a Shared Drive."
      );
      return error(
        "Google Drive storage quota limit: Service Accounts have 0 MB personal storage. The target folder must be inside a Google Workspace Shared Drive (with the bot added as a member) to save to Drive automatically. The file was downloaded locally.",
        403
      );
    }

    const msg = err instanceof Error ? err.message : "Failed to upload Excel to Drive";
    console.error("[POST /api/print-jobs/upload-excel]", err);
    return serverError(msg);
  }
});
