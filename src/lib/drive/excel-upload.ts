import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { getDriveClient, getExcelFolderId } from "./client";

export interface PrintJobRecord {
  sku:                 string;
  rfid?:               string;
  designNumber?:       string;
  imageName?:          string;
  itemStatus?:         string;
  salesManName?:       string;
  itemType?:           string;
  size?:               string;
  grossWeight?:        number | string;
  netWeight?:          number | string;
  collectionLine?:     string;
  itemCategory?:       string;
  metalType?:          string;
  metalPurity?:        string;
  metalWeight?:        number | string;
  totalDiamondWeight?: number | string;
  totalStoneWeight?:   number | string;
  stoneWeight?:        number | string;
  sellingPrice?:       number | string;
  reserved1?:          string;
  reserved2?:          string;
  reserved3?:          string;
  csWt?:               string;
  printerId:           string;
  status:              string;
  createdAt:           Date;
  createdBy:           string;
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

export const INSTOCK_HEADERS = [
  "RFID Tag", "SKU Number", "Design Number", "Image Name", "Item Status",
  "Sales Man Name", "Item Type", "Size", "Gross Weight", "Net Weight",
  "Collection Line", "Item Category", "Metal Type", "Metal Purity", "Metal Weight",
  "Total Diamond Weight", "Total Stone Weight", "Center Stone Type",
  "Center Stone Shape ", "Center Stone Size", "Center Stone Quality ",
  "Center Stone Color ", "Center Stone Weight ", "Center Stone Certificate",
  "Center Stone Cut", "Stone Type", "Stone Shape", "Stone Size", "Stone Quality",
  "Stone Color", "Stone Count", "Stone Weight", "Stone Certificate", "Stone Cut",
  "Total Stone Count", "Finding Type", "Finding Metal", "Finding Weight",
  "Finding Metal Purity", "Gold Lock", "Silver Lock", "Platinum Lock",
  "Cost Price", "Fob Price", "Selling Price", "Metal Price", "Diamond Price",
  "Stone Price", "Labor Price", "Labor Charges Per Gram", "Set Id",
  "Set Image Name", "Company", "Location", "Counter Number",
  "Counter Description", "Tray Number", "Tray Description", "Owner", "Customer",
  "Kundan Weight", "Kundan Pcs", "Meena Weight", "Remarks",
  "Reserved 1", "Reserved 2", "Reserved 3", "Reserved 4", "Reserved 5",
  "Reserved 6", "Reserved 7",
] as const;

async function buildExcelBuffer(records: PrintJobRecord[]): Promise<Buffer> {
  const workbook  = new ExcelJS.Workbook();
  workbook.creator  = "BJ Printer System";
  workbook.created  = new Date();

  const sheet = workbook.addWorksheet("Products", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = INSTOCK_HEADERS.map((h, i) => ({
    header: h,
    key: `col_${i}`,
    width: i <= 3 ? 18 : [8, 9, 13, 16, 31].includes(i) ? 14 : 12,
  }));

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = {
      bold: true,
      size: 11,
      name: "Calibri",
    };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  headerRow.height = 22;

  records.forEach((rec) => {
    const parseWeightValue = (val: unknown): { value: number | string; numFmt?: string } => {
      if (val === undefined || val === null || val === "") {
        return { value: "" };
      }
      const s = String(val).trim();
      if (s === "") {
        return { value: "" };
      }
      const n = typeof val === "number" ? val : Number(s);
      if (isNaN(n)) {
        return { value: s };
      }
      const dot = s.indexOf(".");
      const decimals = dot === -1 ? 0 : s.length - dot - 1;
      const numFmt = decimals > 0 ? "0." + "0".repeat(decimals) : "0.000";
      return { value: n, numFmt };
    };

    const gross      = parseWeightValue(rec.grossWeight);
    const net        = parseWeightValue(rec.netWeight);
    const totalStone = parseWeightValue(rec.totalStoneWeight ?? rec.stoneWeight);
    const stone      = parseWeightValue(rec.stoneWeight);
    const cz         = parseWeightValue(rec.reserved1);
    const bs         = parseWeightValue(rec.reserved3);

    const formatExcelSku = (val?: string | null): string => {
      if (!val) return "";
      const s = String(val).trim();
      if (!s) return "";
      return s.startsWith("1") ? s : `1${s}`;
    };

    const cleanPurity = (val?: string | null): string | number => {
      if (!val) return "";
      const s = String(val).replace(/[kK\s]/g, "").replace(/T$/i, "");
      const n = Number(s);
      return isNaN(n) ? s : n;
    };

    const formattedSku = formatExcelSku(rec.sku);
    const formattedRfid = formatExcelSku(rec.rfid ?? rec.sku);

    const rowValues = new Array(71).fill("");
    rowValues[0]  = formattedRfid;
    rowValues[1]  = formattedSku;
    rowValues[2]  = rec.designNumber  ?? "";
    rowValues[3]  = rec.imageName     ?? (rec.designNumber ? `${rec.designNumber}.jpg` : "");
    rowValues[4]  = "INSTOCK";
    rowValues[5]  = rec.salesManName  ?? "";
    rowValues[6]  = rec.itemType      ?? "";
    rowValues[7]  = rec.size          ?? "";
    rowValues[8]  = gross.value;
    rowValues[9]  = net.value;
    rowValues[10] = rec.collectionLine ?? "";
    rowValues[11] = rec.itemCategory  ?? "";
    rowValues[12] = rec.metalType     ?? "";
    rowValues[13] = cleanPurity(rec.metalPurity);
    rowValues[14] = ""; // Metal Weight
    rowValues[15] = ""; // Total Diamond Weight
    rowValues[16] = totalStone.value;
    rowValues[31] = stone.value;
    rowValues[64] = cz.value;
    rowValues[66] = bs.value;

    const row = sheet.addRow(rowValues);

    row.eachCell((cell) => {
      cell.font      = { size: 10, name: "Calibri" };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });

    if (gross.numFmt)      row.getCell(9).numFmt  = gross.numFmt;
    if (net.numFmt)        row.getCell(10).numFmt = net.numFmt;
    if (totalStone.numFmt) row.getCell(17).numFmt = totalStone.numFmt;
    if (stone.numFmt)      row.getCell(32).numFmt = stone.numFmt;
    if (cz.numFmt)         row.getCell(65).numFmt = cz.numFmt;
    if (bs.numFmt)         row.getCell(67).numFmt = bs.numFmt;

    row.height = 18;
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: sheet.columns.length },
  };

  return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

export async function uploadExcelBufferToDrive(
  buffer: Buffer,
  fileName: string
): Promise<string> {
  const cleanFileName = fileName.endsWith(".xlsx") ? fileName : `${fileName}.xlsx`;
  const folderId   = getExcelFolderId();

  // If a Google Apps Script Web App URL is provided, upload directly via Apps Script.
  // This executes as the Google account owner (brahammand.jewels@gmail.com),
  // creating the file directly in the Exhibition Excel folder without Service Account 0 MB quota restrictions.
  const appsScriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL?.trim().replace(/^["']+|["']+$/g, "");
  if (appsScriptUrl) {
    const res = await fetch(appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: cleanFileName,
        base64: buffer.toString("base64"),
        folderId: folderId,
      }),
      redirect: "follow",
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[excel-upload] Apps Script failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { success?: boolean; fileId?: string; fileUrl?: string; error?: string };
    if (!data.success && data.error) {
      throw new Error(`[excel-upload] Apps Script error: ${data.error}`);
    }

    if (data.fileId) {
      console.log(
        `[excel-upload] Uploaded "${cleanFileName}" via Google Apps Script → Drive file ID: ${data.fileId}` +
          (data.fileUrl ? ` | ${data.fileUrl}` : "")
      );
      return data.fileId;
    }
  }

  const fileStream = bufferToStream(buffer);
  const drive      = getDriveClient();

  const response = await drive.files.create({
    requestBody: {
      name:    cleanFileName,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      parents: [folderId],
    },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body:     fileStream,
    },
    fields: "id,name,webViewLink",
    supportsAllDrives: true,
  });

  const fileId = response.data.id;
  if (!fileId) {
    throw new Error("[excel-upload] Drive API returned no file ID.");
  }

  console.log(
    `[excel-upload] Uploaded "${cleanFileName}" → Drive file ID: ${fileId}` +
    (response.data.webViewLink ? ` | ${response.data.webViewLink}` : "")
  );

  return fileId;
}

export async function uploadPrintJobsToExcel(
  records: PrintJobRecord[],
  customFileName?: string
): Promise<string> {
  if (records.length === 0) {
    throw new Error("[excel-upload] No records provided.");
  }

  const firstRecord = records[0];
  const timestamp   = formatTimestamp(firstRecord.createdAt);
  const skuLabel    = records.length === 1 ? firstRecord.sku : `BATCH_${records.length}`;
  const fileName    = customFileName
    ? (customFileName.endsWith(".xlsx") ? customFileName : `${customFileName}.xlsx`)
    : `BJ_Print_${skuLabel}_${timestamp}.xlsx`;

  const buffer = await buildExcelBuffer(records);
  return uploadExcelBufferToDrive(buffer, fileName);
}
