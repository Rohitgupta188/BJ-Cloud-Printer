import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { getDriveClient, getExcelFolderId } from "./client";

export interface PrintJobRecord {
  sku:            string;
  rfid?:          string;
  designNumber?:  string;
  metalType?:     string;
  metalPurity?:   string;
  grossWeight?:   number;
  netWeight?:     number;
  stoneWeight?:   number;
  collectionLine?: string;
  reserved1?:     string;
  reserved3?:     string;
  printerId:      string;
  status:         string;
  createdAt:      Date;
  createdBy:      string;
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Convert in-memory Buffer to a standard Node.js Readable stream for Google Drive upload. */
function bufferToStream(buf: Buffer): Readable {
  return Readable.from(Buffer.from(buf));
}

async function buildExcelBuffer(records: PrintJobRecord[]): Promise<Buffer> {
  const workbook  = new ExcelJS.Workbook();
  workbook.creator  = "BJ Printer System";
  workbook.created  = new Date();

  const sheet = workbook.addWorksheet("Print Jobs", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "SKU",             key: "sku",            width: 18 },
    { header: "RFID",            key: "rfid",           width: 18 },
    { header: "Design No.",      key: "designNumber",   width: 14 },
    { header: "Metal Type",      key: "metalType",      width: 14 },
    { header: "Purity",          key: "metalPurity",    width: 10 },
    { header: "Gross Wt (g)",    key: "grossWeight",    width: 14 },
    { header: "Net Wt (g)",      key: "netWeight",      width: 13 },
    { header: "Stone Wt (g)",    key: "stoneWeight",    width: 14 },
    { header: "Collection",      key: "collectionLine", width: 18 },
    { header: "CZ (Reserved 1)", key: "reserved1",      width: 16 },
    { header: "BS (Reserved 3)", key: "reserved3",      width: 16 },
    { header: "Printer",         key: "printerId",      width: 14 },
    { header: "Status",          key: "status",         width: 16 },
    { header: "Created At",      key: "createdAt",      width: 22 },
    { header: "Created By",      key: "createdBy",      width: 28 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = {
      type:    "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1A1A2E" },
    };
    cell.font = {
      bold:  true,
      color: { argb: "FFFFD700" },
      size:  11,
      name:  "Calibri",
    };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = {
      bottom: { style: "medium", color: { argb: "FFFFD700" } },
    };
  });
  headerRow.height = 22;

  records.forEach((rec, idx) => {
    const row = sheet.addRow({
      sku:            rec.sku,
      rfid:           rec.rfid ?? rec.sku,
      designNumber:   rec.designNumber  ?? "—",
      metalType:      rec.metalType     ?? "—",
      metalPurity:    rec.metalPurity   ?? "—",
      grossWeight:    rec.grossWeight   ?? "",
      netWeight:      rec.netWeight     ?? "",
      stoneWeight:    rec.stoneWeight   ?? "",
      collectionLine: rec.collectionLine ?? "—",
      reserved1:      rec.reserved1     ?? "—",
      reserved3:      rec.reserved3     ?? "—",
      printerId:      rec.printerId,
      status:         rec.status,
      createdAt:      rec.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      createdBy:      rec.createdBy,
    });

    const rowColor = idx % 2 === 0 ? "FFF5F5F5" : "FFFFFFFF";
    row.eachCell((cell) => {
      cell.fill = {
        type:    "pattern",
        pattern: "solid",
        fgColor: { argb: rowColor },
      };
      cell.font      = { size: 10, name: "Calibri" };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.border = {
        top:    { style: "thin", color: { argb: "FFD0D0D0" } },
        bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
        left:   { style: "thin", color: { argb: "FFD0D0D0" } },
        right:  { style: "thin", color: { argb: "FFD0D0D0" } },
      };
    });

    row.getCell("sku").font = { bold: true, size: 10, name: "Calibri", color: { argb: "FF8B6914" } };
    row.getCell("rfid").font = { bold: true, size: 10, name: "Calibri", color: { argb: "FF8B6914" } };

    const statusCell = row.getCell("status");
    if (rec.status === "MQTT_PUBLISHED") {
      statusCell.font = { bold: true, size: 10, name: "Calibri", color: { argb: "FF276221" } };
    } else if (rec.status === "MQTT_FAILED") {
      statusCell.font = { bold: true, size: 10, name: "Calibri", color: { argb: "FF9B1C1C" } };
    }

    row.height = 18;
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: sheet.columns.length },
  };
  const footerRowNum = records.length + 3;
  const footerRow    = sheet.getRow(footerRowNum);
  footerRow.getCell(1).value = `Total Records: ${records.length}`;
  footerRow.getCell(1).font  = { bold: true, italic: true, size: 10, name: "Calibri" };

  return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

export async function uploadPrintJobsToExcel(
  records: PrintJobRecord[]
): Promise<string> {
  if (records.length === 0) {
    throw new Error("[excel-upload] No records provided.");
  }

  const firstRecord = records[0];
  const timestamp   = formatTimestamp(firstRecord.createdAt);
  const skuLabel    = records.length === 1 ? firstRecord.sku : `BATCH_${records.length}`;
  const fileName    = `BJ_Print_${skuLabel}_${timestamp}.xlsx`;

  const buffer     = await buildExcelBuffer(records);
  const fileStream = bufferToStream(buffer);
  const drive      = getDriveClient();
  const folderId   = getExcelFolderId();

  const response = await drive.files.create({
    requestBody: {
      name:    fileName,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      parents: [folderId],
    },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body:     fileStream,
    },
    fields: "id,name,webViewLink",
  });

  const fileId = response.data.id;
  if (!fileId) {
    throw new Error("[excel-upload] Drive API returned no file ID.");
  }

  console.log(
    `[excel-upload] Uploaded "${fileName}" → Drive file ID: ${fileId}` +
    (response.data.webViewLink ? ` | ${response.data.webViewLink}` : "")
  );

  return fileId;
}
