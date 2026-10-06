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

async function buildExcelBuffer(records: PrintJobRecord[]): Promise<Buffer> {
  const workbook  = new ExcelJS.Workbook();
  workbook.creator  = "BJ Printer System";
  workbook.created  = new Date();

  const sheet = workbook.addWorksheet("Print Jobs", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "RFID Tag",              key: "rfidTag",            width: 18 },
    { header: "SKU Number",            key: "skuNumber",          width: 18 },
    { header: "Design Number",         key: "designNumber",       width: 18 },
    { header: "Image Name",            key: "imageName",          width: 22 },
    { header: "Item Status",           key: "itemStatus",         width: 14 },
    { header: "Sales Man Name",        key: "salesManName",       width: 16 },
    { header: "Item Type",             key: "itemType",           width: 14 },
    { header: "Size",                  key: "size",               width: 10 },
    { header: "Gross Weight",          key: "grossWeight",        width: 14 },
    { header: "Net Weight",            key: "netWeight",          width: 14 },
    { header: "Collection Line",       key: "collectionLine",     width: 18 },
    { header: "Item Category",         key: "itemCategory",       width: 16 },
    { header: "Metal Type",            key: "metalType",          width: 14 },
    { header: "Metal Purity",          key: "metalPurity",        width: 14 },
    { header: "Metal Weight",          key: "metalWeight",        width: 14 },
    { header: "Total Diamond Weight",  key: "totalDiamondWeight", width: 20 },
    { header: "Total Stone Weight",    key: "totalStoneWeight",   width: 18 },
    { header: "Stone Weight",          key: "stoneWeight",        width: 14 },
    { header: "Selling Price",         key: "sellingPrice",       width: 14 },
    { header: "CZ Wt",                 key: "czWt",               width: 12 },
    { header: "Reserved 2",            key: "reserved2",          width: 14 },
    { header: "BS Wt",                 key: "bsWt",               width: 12 },
    { header: "CS Wt",                 key: "csWt",               width: 12 },
  ];

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
      const numFmt = decimals > 0 ? "0." + "0".repeat(decimals) : "0";
      return { value: n, numFmt };
    };

    const gross      = parseWeightValue(rec.grossWeight);
    const net        = parseWeightValue(rec.netWeight);
    const metal      = parseWeightValue(rec.metalWeight ?? rec.netWeight);
    const diamond    = parseWeightValue(rec.totalDiamondWeight);
    const totalStone = parseWeightValue(rec.totalStoneWeight ?? rec.stoneWeight);
    const stone      = parseWeightValue(rec.stoneWeight);
    const price      = parseWeightValue(rec.sellingPrice);
    const cz         = parseWeightValue(rec.reserved1);
    const bs         = parseWeightValue(rec.reserved3);
    const cs         = parseWeightValue(rec.csWt);

    const row = sheet.addRow({
      rfidTag:            rec.rfid ?? rec.sku,
      skuNumber:          rec.sku,
      designNumber:       rec.designNumber  ?? "",
      imageName:          rec.imageName     ?? (rec.designNumber ? `${rec.designNumber}.jpg` : ""),
      itemStatus:         "INSTOCK",
      salesManName:       rec.salesManName  ?? "",
      itemType:           rec.itemType      ?? "",
      size:               rec.size          ?? "",
      grossWeight:        gross.value,
      netWeight:          net.value,
      collectionLine:     rec.collectionLine ?? "",
      itemCategory:       rec.itemCategory  ?? "",
      metalType:          rec.metalType     ?? "",
      metalPurity:        rec.metalPurity   ?? "",
      metalWeight:        metal.value,
      totalDiamondWeight: diamond.value,
      totalStoneWeight:   totalStone.value,
      stoneWeight:        stone.value,
      sellingPrice:       price.value,
      czWt:               cz.value,
      reserved2:          rec.reserved2     ?? "",
      bsWt:               bs.value,
      csWt:               cs.value,
    });

    row.eachCell((cell) => {
      cell.font      = { size: 10, name: "Calibri" };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });

    if (gross.numFmt)      row.getCell("grossWeight").numFmt = gross.numFmt;
    if (net.numFmt)        row.getCell("netWeight").numFmt = net.numFmt;
    if (metal.numFmt)      row.getCell("metalWeight").numFmt = metal.numFmt;
    if (diamond.numFmt)    row.getCell("totalDiamondWeight").numFmt = diamond.numFmt;
    if (totalStone.numFmt) row.getCell("totalStoneWeight").numFmt = totalStone.numFmt;
    if (stone.numFmt)      row.getCell("stoneWeight").numFmt = stone.numFmt;
    if (price.numFmt)      row.getCell("sellingPrice").numFmt = price.numFmt;
    if (cz.numFmt)         row.getCell("czWt").numFmt = cz.numFmt;
    if (bs.numFmt)         row.getCell("bsWt").numFmt = bs.numFmt;
    if (cs.numFmt)         row.getCell("csWt").numFmt = cs.numFmt;

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
