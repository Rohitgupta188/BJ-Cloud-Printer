"use client";

import {
  useState,
  useEffect,
  useRef,
  useTransition,
  useCallback,
  useId,
  ChangeEvent,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { csrfHeaders } from "@/lib/security/csrf-client";
import { authFetch } from "@/lib/auth/auth-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Printer,
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowLeft,
  FileSpreadsheet,
  Plus,
  Trash2,
  Clock,
  ChevronDown,
  ChevronUp,
  ImageOff,
  Download,
  FileUp,
  Sparkles,
  Layers,
  X,
} from "lucide-react";
import Link from "next/link";

// ── Types ──────────────────────────────────────────────────────────────────

interface RowData {
  id: string;
  prefix: string;
  referenceSku?: string; // Previous/repeat order SKU (used for catalog auto-fill & reference)
  designNumber: string;
  imageName?: string;
  itemStatus?: string;
  grossWeight: string;
  netWeight: string;
  stoneWeight: string;
  metalType: string;
  metalPurity: string;
  collectionLine: string;
  reserved1: string;
  reserved3: string;
  imageUrl?: string;
  imageLoading: boolean;
  expanded: boolean;
}

type JobResult =
  | { status: "success"; sku: string; jobId: string; mqttStatus: string }
  | { status: "error"; sku: string; message: string };

interface CatalogBatchItem {
  sku?: string;
  designNumber?: string;
  imageName?: string;
  prefix?: string;
  itemType?: string;
  grossWeight?: number;
  netWeight?: number;
  stoneWeight?: number;
  metalType?: string;
  metalPurity?: string;
  collectionLine?: string;
  reserved1?: string;
  reserved3?: string;
  imageUrl?: string;
  source?: "catalog" | "printJob";
}

// ── SKU helpers ────────────────────────────────────────────────────────────

/**
 * Given a base SKU like "TRTP5614" and an offset, returns "TRTP5615", "TRTP5616" etc.
 * Preserves zero-padding width.
 */
function offsetSku(baseSku: string, offset: number): string {
  if (offset === 0) return baseSku;
  const match = baseSku.match(/^(.*?)(\d+)$/);
  if (!match) return baseSku;
  const [, prefix, numStr] = match;
  const next = String(Number(numStr) + offset).padStart(numStr.length, "0");
  return prefix + next;
}

// ── Cell extraction & normalization for Excel ──────────────────────────────

function getCellString(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (obj.text !== undefined) return String(obj.text).trim();
    if (obj.result !== undefined) return String(obj.result).trim();
    if (Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>)
        .map((t) => t.text || "")
        .join("")
        .trim();
    }
    return String(val).trim();
  }
  return String(val).trim();
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mapHeaderToKey(
  headerStr: string
): keyof Omit<RowData, "id" | "imageUrl" | "imageLoading" | "expanded"> | null {
  const norm = normalizeHeader(headerStr);
  if (["sku", "skunumber", "skuno", "barcode", "rfid", "rfidtag", "referencesku", "prevsku"].includes(norm))
    return "referenceSku";
  if (["itemtype", "prefix", "type"].includes(norm)) return "prefix";
  if (["designnumber", "designno", "design", "dno"].includes(norm)) return "designNumber";
  if (["imagename", "image", "imgname", "photo"].includes(norm)) return "imageName";
  if (["itemstatus", "status"].includes(norm)) return "itemStatus";
  if (["grossweight", "grossweightg", "grosswt", "grosswtg", "gross", "gwt"].includes(norm))
    return "grossWeight";
  if (["netweight", "netweightg", "netwt", "netwtg", "net", "nwt", "metalweight"].includes(norm))
    return "netWeight";
  if (
    [
      "stoneweight",
      "totalstoneweight",
      "stoneweightg",
      "stonewt",
      "stonewtg",
      "stone",
      "swt",
    ].includes(norm)
  )
    return "stoneWeight";
  if (["metaltype", "metal"].includes(norm)) return "metalType";
  if (["metalpurity", "purity", "kt", "karat"].includes(norm)) return "metalPurity";
  if (["collectionline", "collection", "line"].includes(norm)) return "collectionLine";
  if (["czwt", "cz", "czweight", "czreserved1", "reserved1"].includes(norm))
    return "reserved1";
  if (["bswt", "bs", "bsweight", "bsreserved3", "reserved3"].includes(norm))
    return "reserved3";
  return null;
}

// ── Other helpers ──────────────────────────────────────────────────────────

function makeRow(id: string, initial?: Partial<RowData>): RowData {
  return {
    id,
    prefix: "",
    referenceSku: "",
    designNumber: "",
    imageName: "",
    itemStatus: "INSTOCK",
    grossWeight: "",
    netWeight: "",
    stoneWeight: "",
    metalType: "",
    metalPurity: "",
    collectionLine: "",
    reserved1: "",
    reserved3: "",
    imageUrl: undefined,
    imageLoading: false,
    expanded: true,
    ...initial,
  };
}

function roundWeight(num: number): string {
  if (isNaN(num) || !isFinite(num)) return "";
  return parseFloat(num.toFixed(3)).toString();
}

function computeWeights(
  row: RowData,
  field: "grossWeight" | "stoneWeight" | "reserved1" | "reserved3",
  val: string
): Partial<RowData> {
  if (field === "grossWeight") {
    const patch: Partial<RowData> = { grossWeight: val };
    const grossNum = parseFloat(val);
    if (!isNaN(grossNum)) {
      const stoneNum = parseFloat(row.stoneWeight);
      if (!isNaN(stoneNum)) {
        patch.netWeight = roundWeight(grossNum - stoneNum);
      } else {
        const r1Num = parseFloat(row.reserved1);
        const r3Num = parseFloat(row.reserved3);
        const cz = !isNaN(r1Num) ? r1Num : 0;
        const bs = !isNaN(r3Num) ? r3Num : 0;
        if (!isNaN(r1Num) || !isNaN(r3Num)) {
          patch.netWeight = roundWeight(grossNum - (cz + bs));
        } else {
          // If no stone weight entered yet, Net Weight matches Gross Weight
          patch.netWeight = val;
        }
      }
    } else if (val.trim() === "") {
      patch.netWeight = "";
    }
    return patch;
  }

  if (field === "stoneWeight") {
    const patch: Partial<RowData> = { stoneWeight: val };
    const stoneNum = parseFloat(val);
    const grossNum = parseFloat(row.grossWeight);
    if (!isNaN(grossNum)) {
      if (!isNaN(stoneNum)) {
        patch.netWeight = roundWeight(grossNum - stoneNum);
      } else if (val.trim() === "") {
        patch.netWeight = row.grossWeight;
      }
    }
    return patch;
  }

  if (field === "reserved1" || field === "reserved3") {
    const newR1 = field === "reserved1" ? val : row.reserved1;
    const newR3 = field === "reserved3" ? val : row.reserved3;
    const patch: Partial<RowData> = { [field]: val };

    const r1Num = parseFloat(newR1);
    const r3Num = parseFloat(newR3);
    const hasR1 = !isNaN(r1Num);
    const hasR3 = !isNaN(r3Num);

    if (hasR1 || hasR3) {
      const cz = hasR1 ? r1Num : 0;
      const bs = hasR3 ? r3Num : 0;
      const stone = cz + bs;
      const stoneStr = roundWeight(stone);
      patch.stoneWeight = stoneStr;

      const grossNum = parseFloat(row.grossWeight);
      if (!isNaN(grossNum)) {
        patch.netWeight = roundWeight(grossNum - stone);
      }
    } else if (newR1.trim() === "" && newR3.trim() === "") {
      patch.stoneWeight = "";
      const grossNum = parseFloat(row.grossWeight);
      if (!isNaN(grossNum)) {
        patch.netWeight = row.grossWeight;
      }
    }
    return patch;
  }

  return { [field]: val };
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Excel Export ───────────────────────────────────────────────────────────

async function generateAndDownloadBatchExcel(
  entries: { row: RowData; displaySku: string; result: JobResult | null }[],
  customFileName?: string
): Promise<{ blob: Blob; fileName: string }> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "BJ Cloud Printer";
  wb.created = new Date();
  const ws = wb.addWorksheet("Print Jobs");

  ws.columns = [
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

  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, size: 10 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  headerRow.height = 22;

  entries.forEach(({ row, displaySku, result }) => {
    const skuVal = result?.status === "success" ? result.sku : displaySku || "";
    ws.addRow({
      rfidTag:            skuVal,
      skuNumber:          skuVal,
      designNumber:       row.designNumber || "",
      imageName:          row.imageName || (row.designNumber ? `${row.designNumber}.jpg` : ""),
      itemStatus:         row.itemStatus || "INSTOCK",
      salesManName:       "",
      itemType:           row.prefix || "",
      size:               "",
      grossWeight:        row.grossWeight ? Number(row.grossWeight) : "",
      netWeight:          row.netWeight ? Number(row.netWeight) : "",
      collectionLine:     row.collectionLine || "",
      itemCategory:       "",
      metalType:          row.metalType || "",
      metalPurity:        row.metalPurity || "",
      metalWeight:        row.netWeight ? Number(row.netWeight) : "",
      totalDiamondWeight: "",
      totalStoneWeight:   row.stoneWeight ? Number(row.stoneWeight) : "",
      stoneWeight:        row.stoneWeight ? Number(row.stoneWeight) : "",
      sellingPrice:       "",
      czWt:               row.reserved1 || "",
      reserved2:          "",
      bsWt:               row.reserved3 || "",
      csWt:               "",
    });
  });

  ws.eachRow((r, ri) => {
    if (ri === 1) return;
    r.height = 18;
    r.eachCell((cell) => {
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
  });

  let fileName = (customFileName || "").trim();
  if (!fileName) {
    fileName = `print-jobs-${new Date().toISOString().slice(0, 10)}.xlsx`;
  } else if (!fileName.toLowerCase().endsWith(".xlsx")) {
    fileName = `${fileName}.xlsx`;
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);

  return { blob, fileName };
}

// ── Sample Template Download ───────────────────────────────────────────────

async function downloadSampleExcelTemplate() {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "BJ Cloud Printer";
  wb.created = new Date();
  const ws = wb.addWorksheet("Import Template");

  ws.columns = [
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

  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, size: 10 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  headerRow.height = 22;

  // Sample row 1
  ws.addRow({
    rfidTag:            "RFID001",
    skuNumber:          "DZSGR1001",
    designNumber:       "DZSGR-6961",
    imageName:          "DZSGR-6961.jpg",
    itemStatus:         "INSTOCK",
    salesManName:       "John",
    itemType:           "DZSGR",
    size:               "16",
    grossWeight:        12.45,
    netWeight:          12.074,
    collectionLine:     "Bridal",
    itemCategory:       "Ring",
    metalType:          "R",
    metalPurity:        "18K",
    metalWeight:        12.074,
    totalDiamondWeight: 0,
    totalStoneWeight:   0.376,
    stoneWeight:        0.376,
    sellingPrice:       45000,
    czWt:               "0.000",
    reserved2:          "",
    bsWt:               "0.376",
    csWt:               "",
  });

  // Sample row 2
  ws.addRow({
    rfidTag:            "RFID002",
    skuNumber:          "DZMS1002",
    designNumber:       "DZMS-2963",
    imageName:          "DZMS-2963.jpg",
    itemStatus:         "INSTOCK",
    salesManName:       "Sarah",
    itemType:           "DZMS",
    size:               "14",
    grossWeight:        1.641,
    netWeight:          1.611,
    collectionLine:     "Classic",
    itemCategory:       "Pendant",
    metalType:          "Y",
    metalPurity:        "18K",
    metalWeight:        1.611,
    totalDiamondWeight: 0,
    totalStoneWeight:   0.03,
    stoneWeight:        0.03,
    sellingPrice:       12500,
    czWt:               "0.030",
    reserved2:          "",
    bsWt:               "0.000",
    csWt:               "",
  });

  ws.eachRow((r, ri) => {
    if (ri === 1) return;
    r.height = 20;
    r.eachCell((cell) => {
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bj-print-import-template.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Field ──────────────────────────────────────────────────────────────────

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

// ── StatusBadge ────────────────────────────────────────────────────────────

function StatusBadge({ result }: { result: JobResult | null }) {
  if (!result)
    return (
      <Badge
        variant="outline"
        className="text-[10px] border-border/40 text-muted-foreground"
      >
        <Clock className="mr-1 h-3 w-3" /> Pending
      </Badge>
    );
  if (result.status === "success")
    return (
      <Badge className="text-[10px] bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
        <CheckCircle2 className="mr-1 h-3 w-3" /> {result.mqttStatus}
      </Badge>
    );
  return (
    <Badge variant="destructive" className="text-[10px]">
      <XCircle className="mr-1 h-3 w-3" /> Failed
    </Badge>
  );
}

// ── JobRow ─────────────────────────────────────────────────────────────────

function JobRow({
  row,
  index,
  displaySku,
  skuLoading,
  result,
  isSubmitting,
  onChange,
  onRemove,
}: {
  row: RowData;
  index: number;
  displaySku: string;
  skuLoading: boolean;
  result: JobResult | null;
  isSubmitting: boolean;
  onChange: (patch: Partial<RowData>) => void;
  onRemove: () => void;
}) {
  const baseId = useId();
  const designTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchImage = useCallback(
    async (dn: string, imgName?: string) => {
      const trimmed = dn.trim();
      const trimmedImg = (imgName || "").trim();
      const lookup = trimmed || (trimmedImg ? trimmedImg.replace(/\.jpg$/i, "") : "");
      if (!lookup) {
        onChange({ imageUrl: undefined });
        return;
      }
      onChange({ imageLoading: true });
      try {
        const res = await fetch(
          `/api/catalog/design/${encodeURIComponent(lookup)}`
        );
        const data = await res.json();
        if (res.ok && data.data) {
          const item = data.data;
          const r1 = item.reserved1 != null ? String(item.reserved1) : "";
          const r3 = item.reserved3 != null ? String(item.reserved3) : "";
          const gWt = item.grossWeight != null ? String(item.grossWeight) : "";
          let sWt = item.stoneWeight != null ? String(item.stoneWeight) : "";
          let nWt = item.netWeight != null ? String(item.netWeight) : "";

          const r1Num = parseFloat(r1);
          const r3Num = parseFloat(r3);
          const hasR1 = !isNaN(r1Num);
          const hasR3 = !isNaN(r3Num);
          if ((!sWt || sWt === "0") && (hasR1 || hasR3)) {
            sWt = roundWeight((hasR1 ? r1Num : 0) + (hasR3 ? r3Num : 0));
          }
          const sNum = parseFloat(sWt);
          const gNum = parseFloat(gWt);
          if ((!nWt || nWt === "0") && !isNaN(gNum) && !isNaN(sNum)) {
            nWt = roundWeight(gNum - sNum);
          }

          onChange({
            imageUrl: item.imageUrl,
            imageName:
              item.imageName ||
              (item.designNumber ? `${item.designNumber}.jpg` : imgName || `${lookup}.jpg`),
            grossWeight: gWt,
            netWeight: nWt,
            stoneWeight: sWt,
            metalType: item.metalType ?? "",
            metalPurity: item.metalPurity ?? "",
            collectionLine: item.collectionLine ?? "",
            reserved1: r1,
            reserved3: r3,
          });
        } else {
          onChange({ imageUrl: undefined });
        }
      } catch {
        onChange({ imageUrl: undefined });
      } finally {
        onChange({ imageLoading: false });
      }
    },
    [onChange]
  );

  function handleDesignChange(val: string) {
    const trimmed = val.trim();
    const prevExpected = row.designNumber.trim() ? `${row.designNumber.trim()}.jpg` : "";
    const shouldUpdateImageName = !row.imageName || row.imageName === prevExpected;
    const newImageName = shouldUpdateImageName ? (trimmed ? `${trimmed}.jpg` : "") : row.imageName;

    onChange({ designNumber: val, imageName: newImageName });
    if (designTimer.current) clearTimeout(designTimer.current);
    designTimer.current = setTimeout(() => fetchImage(val, newImageName), 800);
  }

  function handleImageNameChange(val: string) {
    onChange({ imageName: val });
    if (designTimer.current) clearTimeout(designTimer.current);
    designTimer.current = setTimeout(() => fetchImage(row.designNumber, val), 800);
  }

  useEffect(
    () => () => {
      if (designTimer.current) clearTimeout(designTimer.current);
    },
    []
  );

  const done = !!result;
  const id = (field: string) => `${baseId}-${field}`;

  return (
    <Card
      className={`border-border/40 overflow-hidden transition-all ${
        result?.status === "success"
          ? "border-emerald-500/30"
          : result?.status === "error"
            ? "border-destructive/30"
            : ""
      }`}
    >
      {/* ── Row header ── */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none bg-muted/10 hover:bg-muted/20 transition-colors"
        onClick={() => onChange({ expanded: !row.expanded })}
      >
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary shrink-0">
          {index + 1}
        </div>

        <div className="flex flex-1 items-center gap-2 min-w-0 flex-wrap">
          {row.prefix && (
            <span className="font-mono text-xs font-semibold text-foreground">
              {row.prefix}
            </span>
          )}
          {displaySku && (
            <span className="font-mono text-xs font-medium text-primary">
              → {displaySku}
            </span>
          )}
          {skuLoading && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
          {!row.prefix && (
            <span className="text-xs text-muted-foreground">
              Row {index + 1} — enter Item Type
            </span>
          )}
        </div>

        <StatusBadge result={result} />

        {!done && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            disabled={isSubmitting}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}

        {row.expanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
      </div>

      {/* ── Row body ── */}
      {row.expanded && (
        <CardContent className="pt-4 pb-5">
          {/* Two-column: form (left) + image (right) */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* ── Left: form fields (2/3 width) ── */}
            <div className="lg:col-span-2 space-y-4">
              {/* Row 1: Item type + Design number + Image Name */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Field label="Item Type *" id={id("prefix")}>
                  <Input
                    id={id("prefix")}
                    value={row.prefix}
                    onChange={(e) =>
                      onChange({
                        prefix: e.target.value.toUpperCase(),
                      })
                    }
                    placeholder="e.g. TRTP, RING"
                    className="h-10 font-mono uppercase tracking-widest"
                    maxLength={20}
                    disabled={done || isSubmitting}
                  />
                </Field>

                <Field label="Design Number" id={id("design")}>
                  <div className="relative">
                    <Input
                      id={id("design")}
                      value={row.designNumber}
                      onChange={(e) => handleDesignChange(e.target.value)}
                      placeholder="e.g. DZGR35196"
                      className="h-10"
                      disabled={done || isSubmitting}
                    />
                    {row.imageLoading && (
                      <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                  </div>
                </Field>

                <Field label="Image Name" id={id("imageName")}>
                  <Input
                    id={id("imageName")}
                    value={row.imageName || ""}
                    onChange={(e) => handleImageNameChange(e.target.value)}
                    placeholder="e.g. DZGR35196.jpg"
                    className="h-10 font-mono text-xs"
                    disabled={done || isSubmitting}
                  />
                </Field>
              </div>

              <Separator className="opacity-30" />

              {/* Row 2: Gross + Stone */}
              <div className="grid grid-cols-2 gap-4">
                <Field label="Gross Weight (g)" id={id("gross")}>
                  <Input
                    id={id("gross")}
                    type="number"
                    step="0.001"
                    min="0"
                    value={row.grossWeight}
                    onChange={(e) =>
                      onChange(computeWeights(row, "grossWeight", e.target.value))
                    }
                    placeholder="0.000"
                    className="h-10"
                    disabled={done || isSubmitting}
                  />
                </Field>
                <Field label="Stone Weight (g)" id={id("stone")}>
                  <Input
                    id={id("stone")}
                    type="number"
                    step="0.001"
                    min="0"
                    value={row.stoneWeight}
                    readOnly
                    placeholder="0.000"
                    className="h-10 bg-muted/40 cursor-not-allowed font-medium text-muted-foreground select-none"
                    tabIndex={-1}
                  />
                </Field>
              </div>

              {/* Row 3: Net + Metal type */}
              <div className="grid grid-cols-2 gap-4">
                <Field label="Net Weight (g)" id={id("net")}>
                  <Input
                    id={id("net")}
                    type="number"
                    step="0.001"
                    min="0"
                    value={row.netWeight}
                    readOnly
                    placeholder="0.000"
                    className="h-10 bg-muted/40 cursor-not-allowed font-medium text-muted-foreground select-none"
                    tabIndex={-1}
                  />
                </Field>
                <Field label="Metal Type" id={id("metal")}>
                  <Input
                    id={id("metal")}
                    value={row.metalType}
                    onChange={(e) =>
                      onChange({ metalType: e.target.value.toUpperCase() })
                    }
                    placeholder="R, S, Y"
                    className="h-10 font-mono uppercase"
                    disabled={done || isSubmitting}
                  />
                </Field>
              </div>

              {/* Row 4: Purity + Collection */}
              <div className="grid grid-cols-2 gap-4">
                <Field label="Metal Purity" id={id("purity")}>
                  <Input
                    id={id("purity")}
                    value={row.metalPurity}
                    onChange={(e) =>
                      onChange({ metalPurity: e.target.value.toUpperCase() })
                    }
                    placeholder="18K, 22K, 9K"
                    className="h-10 font-mono uppercase"
                    disabled={done || isSubmitting}
                  />
                </Field>
                <Field label="Collection Line" id={id("collection")}>
                  <Input
                    id={id("collection")}
                    value={row.collectionLine}
                    onChange={(e) => onChange({ collectionLine: e.target.value })}
                    placeholder="Bridal, Classic…"
                    className="h-10"
                    disabled={done || isSubmitting}
                  />
                </Field>
              </div>

              {/* Row 5: CZ (reserved1) + BS (reserved3) */}
              <div className="grid grid-cols-2 gap-4">
                <Field label="CZ (Reserved 1)" id={id("reserved1")}>
                  <Input
                    id={id("reserved1")}
                    value={row.reserved1}
                    onChange={(e) =>
                      onChange(computeWeights(row, "reserved1", e.target.value))
                    }
                    placeholder="e.g. 12"
                    className="h-10"
                    disabled={done || isSubmitting}
                  />
                </Field>
                <Field label="BS (Reserved 3)" id={id("reserved3")}>
                  <Input
                    id={id("reserved3")}
                    value={row.reserved3}
                    onChange={(e) =>
                      onChange(computeWeights(row, "reserved3", e.target.value))
                    }
                    placeholder="e.g. 5"
                    className="h-10"
                    disabled={done || isSubmitting}
                  />
                </Field>
              </div>

              {/* Success / error feedback */}
              {result?.status === "success" && (
                <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-bold text-emerald-400">
                      {result.sku}
                    </p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {result.jobId}
                    </p>
                  </div>
                  <Badge className="ml-auto text-[10px] bg-emerald-500/15 text-emerald-400 border-emerald-500/20">
                    {result.mqttStatus}
                  </Badge>
                </div>
              )}
              {result?.status === "error" && (
                <p className="text-xs text-destructive px-1">{result.message}</p>
              )}
            </div>

            {/* ── Right: image panel (1/3 width) ── */}
            <div className="lg:col-span-1 flex flex-col gap-3">
              {/* SKU preview box — Always shows the newly assigned sequence SKU */}
              {(displaySku || skuLoading) && (
                <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-center transition-all">
                  <p className="text-[10px] text-muted-foreground mb-1">
                    New SKU to Assign
                  </p>
                  {skuLoading ? (
                    <Loader2 className="h-5 w-5 animate-spin text-primary mx-auto" />
                  ) : (
                    <p className="font-mono text-xl font-bold tracking-wider text-primary">
                      {displaySku}
                    </p>
                  )}
                  <p className="text-[9px] text-muted-foreground/60 mt-1">
                    Assigned sequentially on submit
                  </p>
                </div>
              )}

              {/* Product image */}
              <div className="flex-1 flex flex-col items-center justify-center rounded-xl border border-border/30 bg-muted/15 min-h-52 p-3">
                {row.imageLoading ? (
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                ) : row.imageUrl ? (
                  <>
                    <img
                      src={row.imageUrl}
                      alt={row.designNumber || "Product Image"}
                      className="max-h-56 max-w-full rounded-lg object-contain shadow-lg ring-1 ring-border/20"
                    />
                    <span className="mt-2 text-[10px] font-mono text-muted-foreground text-center break-all">
                      {row.imageName || (row.designNumber ? `${row.designNumber}.jpg` : "")}
                    </span>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-2 text-center">
                    <ImageOff className="h-8 w-8 text-muted-foreground/30" />
                    <p className="text-xs text-muted-foreground/60">
                      {row.designNumber
                        ? "Design image not found"
                        : "Enter design number to view image"}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function NewPrintJobPage() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [rows, setRows] = useState<RowData[]>(() => [makeRow(uid())]);
  const [results, setResults] = useState<Map<string, JobResult>>(new Map());
  const [submitted, setSubmitted] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // ── Excel Filename Modal & Print Flow ─────────────────────────────────────
  const [isNameModalOpen, setIsNameModalOpen] = useState(false);
  const [excelFileName, setExcelFileName] = useState("");
  const [isProcessingBatch, setIsProcessingBatch] = useState(false);

  // ── Batch Metal Defaults ─────────────────────────────────────────────────
  const [batchMetalType, setBatchMetalType] = useState("");
  const [batchMetalPurity, setBatchMetalPurity] = useState("");

  function applyBatchMetalToAll() {
    const trimmedType = batchMetalType.trim();
    const trimmedPurity = batchMetalPurity.trim();

    if (!trimmedType && !trimmedPurity) {
      toast.error("Please enter a Metal Type or Metal Purity to apply.");
      return;
    }

    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        ...(trimmedType ? { metalType: trimmedType } : {}),
        ...(trimmedPurity ? { metalPurity: trimmedPurity } : {}),
      }))
    );

    const parts = [trimmedType, trimmedPurity].filter(Boolean).join(" • ");
    toast.success(
      `Applied ${parts} to all ${rows.length} item${rows.length > 1 ? "s" : ""}.`
    );
  }

  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Prefix cache: maps prefix → first fetched base SKU.
   * Only ONE API call is made per unique prefix; subsequent rows
   * with the same prefix get offset-computed SKU previews.
   */
  const [skuCache, setSkuCache] = useState<Record<string, string>>({});
  const [skuLoading, setSkuLoading] = useState<Record<string, boolean>>({});
  const skuTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // ── SKU fetch: one per prefix ────────────────────────────────────────────

  function schedulePrefixFetch(prefix: string) {
    const up = prefix.trim().toUpperCase();
    if (!up || !/^[A-Z0-9]+$/.test(up)) return;
    if (skuCache[up]) return; // already cached

    if (skuTimers.current[up]) clearTimeout(skuTimers.current[up]);
    skuTimers.current[up] = setTimeout(async () => {
      setSkuLoading((prev) => ({ ...prev, [up]: true }));
      try {
        const res = await fetch(`/api/sku/preview?prefix=${encodeURIComponent(up)}`);
        const data = await res.json();
        if (res.ok && data.data?.sku) {
          setSkuCache((prev) => ({ ...prev, [up]: data.data.sku }));
        }
      } catch {
        /* silent */
      } finally {
        setSkuLoading((prev) => ({ ...prev, [up]: false }));
      }
    }, 600);
  }

  /**
   * Compute the preview SKU for a row.
   * Every printed row ALWAYS receives a newly generated sequential SKU.
   */
  function computeDisplaySku(rowIndex: number): string {
    const row = rows[rowIndex];
    const up = row.prefix.trim().toUpperCase();
    const base = skuCache[up];
    if (!up || !base) return "";

    // Count same-prefix rows above this one
    const offset = rows
      .slice(0, rowIndex)
      .filter((r) => r.prefix.trim().toUpperCase() === up).length;

    return offsetSku(base, offset);
  }

  // ── Row mutations ────────────────────────────────────────────────────────

  function patchRow(id: string, patch: Partial<RowData>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function handlePrefixChange(id: string, value: string) {
    const up = value.toUpperCase();
    patchRow(id, { prefix: up });
    if (up) schedulePrefixFetch(up);
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      makeRow(uid(), {
        metalType: batchMetalType.trim() || (prev[prev.length - 1]?.metalType ?? ""),
        metalPurity: batchMetalPurity.trim() || (prev[prev.length - 1]?.metalPurity ?? ""),
      }),
    ]);
  }

  function removeRow(id: string) {
    setRows((prev) => {
      if (prev.length === 1) return prev;
      return prev.filter((r) => r.id !== id);
    });
  }

  function toggleAllExpanded() {
    const allExpanded = rows.every((r) => r.expanded);
    setRows((prev) => prev.map((r) => ({ ...r, expanded: !allExpanded })));
  }

  // ── Excel Import Handler ─────────────────────────────────────────────────

  async function handleExcelUpload(file: File) {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      toast.error("Please upload a valid Excel (.xlsx or .xls) file.");
      return;
    }

    setIsImporting(true);
    const toastId = toast.loading("Reading Excel file…");

    try {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const arrayBuffer = await file.arrayBuffer();
      await wb.xlsx.load(arrayBuffer);

      const ws = wb.worksheets[0];
      if (!ws) {
        throw new Error("No worksheet found in Excel file.");
      }

      // 1. Locate header row and map column indices
      let headerRowNumber = 1;
      const colMap: Record<
        number,
        keyof Omit<RowData, "id" | "imageUrl" | "imageLoading" | "expanded">
      > = {};

      ws.eachRow((row, rowNumber) => {
        if (Object.keys(colMap).length > 0) return; // already found
        row.eachCell((cell, colNumber) => {
          const str = getCellString(cell.value);
          const mappedKey = mapHeaderToKey(str);
          if (mappedKey) {
            colMap[colNumber] = mappedKey;
          }
        });
        if (Object.keys(colMap).length > 0) {
          headerRowNumber = rowNumber;
        }
      });

      if (Object.keys(colMap).length === 0) {
        throw new Error(
          "Could not detect recognizable headers (e.g. SKU, Item Type, Design Number, Gross Weight)."
        );
      }

      // 2. Read data rows
      const parsedRows: RowData[] = [];

      ws.eachRow((row, rowNumber) => {
        if (rowNumber <= headerRowNumber) return;

        const rowValues: Partial<RowData> = {};
        let hasAnyData = false;

        row.eachCell((cell, colNumber) => {
          const key = colMap[colNumber];
          if (!key) return;
          const val = getCellString(cell.value);
          if (val) {
            hasAnyData = true;
            (rowValues as Record<string, string>)[key] = val;
          }
        });

        if (!hasAnyData) return;

        const rawRefSku = (rowValues.referenceSku || "").toUpperCase().trim();
        const rawDesignNumber = (rowValues.designNumber || "").trim();
        const rawImageName = (rowValues.imageName || "").trim();
        const effectiveImageName =
          rawImageName || (rawDesignNumber ? `${rawDesignNumber}.jpg` : "");
        const rawPrefix = (rowValues.prefix || "").toUpperCase().trim();
        const effectivePrefix =
          rawPrefix ||
          (rawRefSku ? rawRefSku.replace(/\d+$/, "").toUpperCase() : "") ||
          (rawDesignNumber ? rawDesignNumber.replace(/[-_0-9].*$/, "").toUpperCase() : "");

        const rawMetal = (rowValues.metalType || "").trim().toUpperCase();
        const effectiveMetal = rawMetal || batchMetalType.trim();

        const rawPurity = (rowValues.metalPurity || "").trim().toUpperCase();
        const normalizedPurity = /^\d+$/.test(rawPurity)
          ? `${rawPurity}K`
          : rawPurity;
        const effectivePurity = normalizedPurity || batchMetalPurity.trim();

        parsedRows.push(
          makeRow(uid(), {
            referenceSku: rawRefSku,
            prefix: effectivePrefix,
            designNumber: rawDesignNumber,
            imageName: effectiveImageName,
            itemStatus: (rowValues.itemStatus || "INSTOCK").trim(),
            grossWeight: (rowValues.grossWeight || "").trim(),
            netWeight: (rowValues.netWeight || "").trim(),
            stoneWeight: (rowValues.stoneWeight || "").trim(),
            metalType: effectiveMetal,
            metalPurity: effectivePurity,
            collectionLine: (rowValues.collectionLine || "").trim(),
            reserved1: (rowValues.reserved1 || "").trim(),
            reserved3: (rowValues.reserved3 || "").trim(),
            expanded: ws.actualRowCount <= 5,
          })
        );
      });

      if (parsedRows.length === 0) {
        throw new Error("No data rows found below the header row.");
      }

      // Schedule prefix fetches so new sequential SKUs can be computed
      const uniquePrefixes = Array.from(
        new Set(parsedRows.map((r) => r.prefix).filter((p) => !!p))
      );
      uniquePrefixes.forEach((p) => schedulePrefixFetch(p));

      setRows(parsedRows);
      setResults(new Map());
      setSubmitted(false);

      toast.loading(`Imported ${parsedRows.length} items. Auto-filling details…`, {
        id: toastId,
      });

      // 3. Batch Catalog Lookup to auto-fill images, weights, and details
      const queries = parsedRows
        .filter((r) => r.referenceSku || r.designNumber || r.imageName)
        .map((r) => ({
          sku: r.referenceSku || undefined,
          designNumber: r.designNumber || undefined,
          imageName: r.imageName || undefined,
        }));

      if (queries.length > 0) {
        try {
          const res = await authFetch("/api/catalog/lookup-batch", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...csrfHeaders() },
            body: JSON.stringify({ queries }),
          });

          const data = await res.json();
          if (res.ok && data.data?.results) {
            const resultsMap = data.data.results as Record<string, CatalogBatchItem>;

            setRows((current) =>
              current.map((r) => {
                const match =
                  (r.referenceSku
                    ? resultsMap[`sku:${r.referenceSku.toUpperCase()}`]
                    : null) ||
                  (r.designNumber
                    ? resultsMap[`dn:${r.designNumber.toUpperCase()}`]
                    : null) ||
                  (r.imageName
                    ? resultsMap[`img:${r.imageName.toLowerCase()}`]
                    : null);

                if (!match) return r;

                const gWt =
                  r.grossWeight ||
                  (match.grossWeight != null ? String(match.grossWeight) : "");
                const r1 = r.reserved1 || match.reserved1 || "";
                const r3 = r.reserved3 || match.reserved3 || "";
                let sWt =
                  r.stoneWeight ||
                  (match.stoneWeight != null ? String(match.stoneWeight) : "");
                let nWt =
                  r.netWeight ||
                  (match.netWeight != null ? String(match.netWeight) : "");

                const r1Num = parseFloat(r1);
                const r3Num = parseFloat(r3);
                const hasR1 = !isNaN(r1Num);
                const hasR3 = !isNaN(r3Num);
                if ((!sWt || sWt === "0") && (hasR1 || hasR3)) {
                  sWt = roundWeight((hasR1 ? r1Num : 0) + (hasR3 ? r3Num : 0));
                }
                const sNum = parseFloat(sWt);
                const gNum = parseFloat(gWt);
                if ((!nWt || nWt === "0") && !isNaN(gNum) && !isNaN(sNum)) {
                  nWt = roundWeight(gNum - sNum);
                }

                return {
                  ...r,
                  imageUrl: r.imageUrl || match.imageUrl,
                  imageName:
                    r.imageName ||
                    match.imageName ||
                    (match.designNumber ? `${match.designNumber}.jpg` : ""),
                  prefix: r.prefix || match.prefix || match.itemType || "",
                  designNumber: r.designNumber || match.designNumber || "",
                  grossWeight: gWt,
                  netWeight: nWt,
                  stoneWeight: sWt,
                  metalType: r.metalType || match.metalType || "",
                  metalPurity: r.metalPurity || match.metalPurity || "",
                  collectionLine: r.collectionLine || match.collectionLine || "",
                  reserved1: r1,
                  reserved3: r3,
                };
              })
            );
          }
        } catch {
          /* ignore lookup errors */
        }
      }

      toast.success(
        `Successfully loaded ${parsedRows.length} item${
          parsedRows.length > 1 ? "s" : ""
        } from Excel. New sequential SKUs will be assigned on print.`,
        { id: toastId }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to parse Excel file";
      toast.error(msg, { id: toastId });
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleExcelUpload(file);
  }

  // ── Validation ───────────────────────────────────────────────────────────

  function validateAll(): string | null {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.prefix.trim())
        return `Row ${i + 1}: Item Type is required.`;
      if (!/^[A-Z0-9]+$/i.test(r.prefix.trim()))
        return `Row ${i + 1}: Item Type must be alphanumeric.`;
      if (!computeDisplaySku(i))
        return `Row ${i + 1}: SKU preview still loading — wait a moment.`;
    }
    return null;
  }

  // ── Print Flow: Prompt Filename -> Auto-Download -> Save to Drive -> Print to MQTT ──

  function handleSubmit() {
    const err = validateAll();
    if (err) {
      toast.error(err);
      return;
    }

    const firstPrefix = rows[0]?.prefix?.trim() || "BATCH";
    const dateStr = new Date().toISOString().slice(0, 10);
    const defaultName = `BJ_Print_${firstPrefix}_${dateStr}_${rows.length}items.xlsx`;
    setExcelFileName(defaultName);
    setIsNameModalOpen(true);
  }

  async function executePrintFlow(fileNameInput: string) {
    let cleanName = fileNameInput.trim();
    if (!cleanName) {
      toast.error("Please enter a valid Excel file name.");
      return;
    }
    if (!cleanName.toLowerCase().endsWith(".xlsx")) {
      cleanName = `${cleanName}.xlsx`;
    }

    setIsProcessingBatch(true);
    const toastId = toast.loading("Generating Excel file…");

    try {
      // 1. Prepare entries with preview SKUs
      const entries = rows.map((row, i) => ({
        row,
        displaySku: computeDisplaySku(i),
        result: null,
      }));

      // 2. Build workbook and automatically download the Excel file
      const { blob, fileName: finalName } = await generateAndDownloadBatchExcel(
        entries,
        cleanName
      );

      toast.loading(`Saving "${finalName}" to Google Drive…`, { id: toastId });

      // 3. Upload the Excel file directly to Google Drive
      const formData = new FormData();
      formData.append("file", blob, finalName);
      formData.append("fileName", finalName);

      const driveRes = await authFetch("/api/print-jobs/upload-excel", {
        method: "POST",
        headers: csrfHeaders(),
        body: formData,
      });

      if (!driveRes.ok) {
        const driveData = await driveRes.json().catch(() => ({}));
        console.error("[Drive upload error]", driveData);
        toast.warning(
          driveData.error || "Excel downloaded locally. (Google Drive upload failed)",
          { id: toastId, duration: 8000 }
        );
      } else {
        toast.success(`Excel saved to Google Drive & downloaded!`, { id: toastId });
      }

      // Close modal now that file is named, downloaded, and uploaded to Drive
      setIsNameModalOpen(false);

      // 4. Send jobs to MQTT
      startTransition(async () => {
        setSubmitted(true);
        const newResults = new Map<string, JobResult>();

        for (const row of rows) {
          try {
            const res = await authFetch("/api/print-jobs", {
              method: "POST",
              headers: { "Content-Type": "application/json", ...csrfHeaders() },
              body: JSON.stringify({
                prefix: row.prefix.trim().toUpperCase(),
                designNumber: row.designNumber || undefined,
                imageName:
                  row.imageName || (row.designNumber ? `${row.designNumber}.jpg` : undefined),
                itemStatus: row.itemStatus || "INSTOCK",
                grossWeight: row.grossWeight ? Number(row.grossWeight) : undefined,
                netWeight: row.netWeight ? Number(row.netWeight) : undefined,
                stoneWeight: row.stoneWeight ? Number(row.stoneWeight) : undefined,
                metalType: row.metalType || undefined,
                metalPurity: row.metalPurity || undefined,
                collectionLine: row.collectionLine || undefined,
                imageUrl: row.imageUrl || undefined,
                reserved1: row.reserved1 || undefined,
                reserved3: row.reserved3 || undefined,
                skipDriveUpload: true, // Already uploaded the whole batch to Drive with custom name!
              }),
            });

            const data = await res.json();
            if (!res.ok) {
              newResults.set(row.id, {
                status: "error",
                sku: computeDisplaySku(rows.indexOf(row)),
                message: data.error ?? "Server error",
              });
            } else {
              const job = data.data.job;
              newResults.set(row.id, {
                status: "success",
                sku: job.sku,
                jobId: job.jobId,
                mqttStatus: job.status,
              });
              setSkuCache((prev) => ({
                ...prev,
                [row.prefix.toUpperCase()]: job.sku,
              }));
            }
          } catch {
            newResults.set(row.id, {
              status: "error",
              sku: computeDisplaySku(rows.indexOf(row)),
              message: "Network error",
            });
          }
          setResults(new Map(newResults));
        }

        const ok = [...newResults.values()].filter(
          (r) => r.status === "success"
        ).length;
        const fail = rows.length - ok;
        if (fail === 0)
          toast.success(`${ok} job${ok > 1 ? "s" : ""} sent to MQTT printer.`);
        else if (ok === 0) toast.error(`All ${fail} print jobs failed.`);
        else toast.warning(`${ok} printed, ${fail} failed.`);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to process print batch";
      toast.error(msg, { id: toastId });
    } finally {
      setIsProcessingBatch(false);
    }
  }

  // ── Manual Excel Export ──────────────────────────────────────────────────

  async function handleExcel() {
    const entries = rows.map((row, i) => ({
      row,
      displaySku: computeDisplaySku(i),
      result: results.get(row.id) ?? null,
    }));
    try {
      await generateAndDownloadBatchExcel(entries);
      toast.success("Excel downloaded.");
    } catch {
      toast.error("Excel export failed.");
    }
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  function handleReset() {
    setRows([makeRow(uid())]);
    setResults(new Map());
    setSkuCache({});
    setSubmitted(false);
  }

  // ── Derived ──────────────────────────────────────────────────────────────

  const allDone = submitted && results.size === rows.length;
  const successCount = [...results.values()].filter(
    (r) => r.status === "success"
  ).length;
  const failCount = [...results.values()].filter(
    (r) => r.status === "error"
  ).length;
  const hasAnyPrefix = rows.some((r) => r.prefix.trim().length > 0);

  return (
    <div className="flex-1 flex flex-col overflow-auto">
      {/* ── Header ── */}
      <div className="flex items-center gap-4 border-b border-border/50 bg-background/80 px-8 py-5 backdrop-blur-sm sticky top-0 z-10">
        <Button
          variant="ghost"
          size="icon"
          asChild
          className="shrink-0 text-muted-foreground"
        >
          <Link href="/dashboard">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold tracking-tight">New Print Job</h1>
          {/* <p className="mt-0.5 text-xs text-muted-foreground">
            Print single items, repeat orders, or upload an Excel sheet — a new sequential SKU is assigned to every label
          </p> */}
        </div>

        <div className="flex items-center gap-2">
          {/* Hidden File Input */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={onFileChange}
            accept=".xlsx,.xls"
            className="hidden"
          />

          {rows.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={toggleAllExpanded}
            >
              {rows.every((r) => r.expanded) ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" />
                  Collapse All
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" />
                  Expand All
                </>
              )}
            </Button>
          )}

          {allDone && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              className="shrink-0"
            >
              New Batch
            </Button>
          )}
        </div>
      </div>

      {/* ── Scrollable Form Body ── */}
      <div className="flex-1 max-w-6xl w-full space-y-4 px-8 py-8 pb-32">
        {/* ── Quick Import Banner & Drag-and-drop zone ── */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleExcelUpload(file);
          }}
          className={`relative rounded-xl border border-dashed transition-all p-4 ${
            isDragging
              ? "border-emerald-500 bg-emerald-500/10 scale-[1.005]"
              : "border-border/60 bg-muted/10 hover:bg-muted/20"
          }`}
        >
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <FileSpreadsheet className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                  Import Excel for Batch Printing
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                </p>
                {/* <p className="text-xs text-muted-foreground">
                  Upload an Excel (.xlsx) file containing past SKUs or design numbers. Product details & images auto-fill, and new unique SKUs are generated for printing.
                </p> */}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                onClick={() => fileInputRef.current?.click()}
                disabled={isPending || isImporting}
              >
                {isImporting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileUp className="h-3.5 w-3.5" />
                )}
                Import Excel
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={downloadSampleExcelTemplate}
              >
                <Download className="h-3.5 w-3.5" />
                Sample Template
              </Button>
            </div>
          </div>
        </div>

        {/* ── Batch Defaults (Metal Type & Purity) ── */}
        <div className="rounded-xl border border-border/50 bg-card p-4 shadow-xs">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0 border border-amber-500/25">
                <Layers className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    Batch Metal & Purity
                  </h3>
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <div className="flex items-center gap-2">
                <div className="w-36 sm:w-40">
                  <Input
                    value={batchMetalType}
                    onChange={(e) =>
                      setBatchMetalType(e.target.value.toUpperCase())
                    }
                    placeholder="Metal (R, S, Y)"
                    className="h-9 text-xs font-mono uppercase tracking-wider"
                    maxLength={10}
                    disabled={isPending}
                  />
                </div>
                <div className="w-28 sm:w-36">
                  <Input
                    value={batchMetalPurity}
                    onChange={(e) =>
                      setBatchMetalPurity(e.target.value.toUpperCase())
                    }
                    placeholder="Purity (18K, 22K, 9K)"
                    className="h-9 text-xs font-mono uppercase tracking-wider"
                    maxLength={10}
                    disabled={isPending}
                  />
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={applyBatchMetalToAll}
                disabled={
                  isPending ||
                  (!batchMetalType.trim() && !batchMetalPurity.trim())
                }
                className="gap-1.5 h-9 text-xs font-semibold border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-300 shrink-0 cursor-pointer"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Apply to All ({rows.length})
              </Button>
            </div>
          </div>

          {/* Quick presets */}
          <div className="mt-3 pt-3 border-t border-border/30 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
            <span className="text-[10px] uppercase font-medium tracking-wider text-muted-foreground/70">
              Quick presets:
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {[
                { type: "R", purity: "18K" },
                { type: "S", purity: "18K" },
                { type: "Y", purity: "18K" },
                { type: "R", purity: "22K" },
                { type: "Y", purity: "22K" },
                { type: "S", purity: "22K" },
                { type: "R", purity: "9K" },
                { type: "Y", purity: "9K" },
                { type: "S", purity: "9K" },
              ].map((p) => {
                const isSelected =
                  batchMetalType === p.type && batchMetalPurity === p.purity;
                return (
                  <button
                    key={`${p.type}-${p.purity}`}
                    type="button"
                    onClick={() => {
                      setBatchMetalType(p.type);
                      setBatchMetalPurity(p.purity);
                    }}
                    className={`rounded-md border px-2.5 py-1 text-xs font-mono font-medium transition-all cursor-pointer ${
                      isSelected
                        ? "border-amber-500 bg-amber-500/15 text-amber-600 dark:text-amber-400 font-bold shadow-xs"
                        : "border-border/40 bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                    disabled={isPending}
                  >
                    {p.type} {p.purity}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Progress bar ── */}
        {(isPending || allDone) && (
          <div className="flex items-center gap-4 rounded-xl border border-border/40 bg-muted/20 px-5 py-3">
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            )}
            <p className="flex-1 text-sm font-medium">
              {isPending
                ? `Submitting… ${results.size} / ${rows.length}`
                : `Done — ${successCount} of ${rows.length} job${
                    rows.length > 1 ? "s" : ""
                  } created`}
            </p>
            {successCount > 0 && (
              <Badge className="text-[10px] bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                {successCount} OK
              </Badge>
            )}
            {failCount > 0 && (
              <Badge variant="destructive" className="text-[10px]">
                {failCount} Failed
              </Badge>
            )}
          </div>
        )}

        {/* ── Job rows ── */}
        <div className="space-y-3">
          {rows.map((row, i) => (
            <JobRow
              key={row.id}
              row={row}
              index={i}
              displaySku={computeDisplaySku(i)}
              skuLoading={skuLoading[row.prefix.trim().toUpperCase()] ?? false}
              result={results.get(row.id) ?? null}
              isSubmitting={isPending}
              onChange={(patch) => {
                if (patch.prefix !== undefined && patch.prefix !== row.prefix) {
                  handlePrefixChange(row.id, patch.prefix);
                  const { prefix: _, ...rest } = patch;
                  if (Object.keys(rest).length > 0) patchRow(row.id, rest);
                } else {
                  patchRow(row.id, patch);
                }
              }}
              onRemove={() => removeRow(row.id)}
            />
          ))}
        </div>

      </div>

      {/* ── Fixed Pinned Bottom Action Bar ── */}
      <div className="sticky bottom-0 z-20 border-t border-border/50 bg-background/95 backdrop-blur-md px-8 py-3.5 shadow-lg">
        <div className="max-w-6xl flex flex-wrap items-center justify-between gap-3">
          {/* Left: Item Count, Add Item, Download Excel */}
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center rounded-md bg-muted px-2.5 py-1 text-xs font-semibold text-foreground/80">
              {rows.length} {rows.length === 1 ? "Item" : "Items"}
            </span>

            {!allDone && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 border-dashed font-medium text-xs h-8"
                onClick={addRow}
                disabled={isPending}
              >
                <Plus className="h-3.5 w-3.5" />
                Add Item
              </Button>
            )}

            {hasAnyPrefix && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 text-xs h-8"
                onClick={handleExcel}
                disabled={isPending}
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                Download Excel
              </Button>
            )}
          </div>

          {/* Right: Done actions or Submit Print */}
          <div className="flex items-center gap-2">
            {allDone ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push("/dashboard")}
                  className="h-9 text-xs"
                >
                  View All Jobs
                </Button>
                <Button
                  size="sm"
                  className="gap-1.5 h-9 text-xs"
                  onClick={handleReset}
                >
                  <Printer className="h-3.5 w-3.5" />
                  New Batch
                </Button>
              </>
            ) : (
              <Button
                id="submit-batch-btn"
                className="gap-2 min-w-40 font-semibold shadow-xs"
                onClick={handleSubmit}
                disabled={isPending || !hasAnyPrefix}
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Printing {results.size + 1} / {rows.length}…
                  </>
                ) : (
                  <>
                    <Printer className="h-4 w-4" />
                    Print {rows.length} Job{rows.length > 1 ? "s" : ""}
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ── Excel Filename Modal ── */}
      {isNameModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
          <div
            className="w-full max-w-md rounded-2xl border border-border/60 bg-card p-6 shadow-2xl space-y-5 animate-in zoom-in-95 duration-200"
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0">
                  <FileSpreadsheet className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    Name Your Excel File
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Name the Excel file before printing and saving to Google Drive.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => !isProcessingBatch && setIsNameModalOpen(false)}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                disabled={isProcessingBatch}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-xl border border-border/40 bg-muted/20 p-3 space-y-1.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground font-medium">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                <span>Actions performed on confirm:</span>
              </div>
              <ul className="list-disc list-inside space-y-1 pl-1 text-[11px]">
                <li>Auto-downloads Excel file to your computer</li>
                <li>Uploads and saves copy to Google Drive folder</li>
                <li>Dispatches print payloads for {rows.length} item{rows.length > 1 ? "s" : ""} to MQTT</li>
              </ul>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="batch-excel-filename-input"
                className="text-xs font-medium text-foreground block"
              >
                Excel File Name
              </label>
              <div className="relative">
                <Input
                  id="batch-excel-filename-input"
                  value={excelFileName}
                  onChange={(e) => setExcelFileName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isProcessingBatch && excelFileName.trim()) {
                      e.preventDefault();
                      executePrintFlow(excelFileName);
                    }
                  }}
                  placeholder="e.g. BJ_Print_Batch.xlsx"
                  className="h-10 pr-16 font-mono text-xs"
                  autoFocus
                  disabled={isProcessingBatch}
                />
                <span className="absolute right-3 top-2.5 text-xs font-mono text-muted-foreground/60 select-none">
                  .xlsx
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsNameModalOpen(false)}
                disabled={isProcessingBatch}
                className="text-xs h-9 cursor-pointer"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => executePrintFlow(excelFileName)}
                disabled={isProcessingBatch || !excelFileName.trim()}
                className="gap-2 text-xs h-9 font-semibold bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
              >
                {isProcessingBatch ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Saving & Printing…
                  </>
                ) : (
                  <>
                    <Printer className="h-3.5 w-3.5" />
                    Save, Download & Print
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
