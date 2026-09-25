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
} from "lucide-react";
import Link from "next/link";

// ── Types ──────────────────────────────────────────────────────────────────

interface RowData {
  id: string;
  prefix: string;
  referenceSku?: string; // Previous/repeat order SKU (used for catalog auto-fill & reference)
  designNumber: string;
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
  if (["sku", "skunumber", "skuno", "barcode", "rfid", "referencesku", "prevsku"].includes(norm))
    return "referenceSku";
  if (["itemtype", "prefix", "type", "category"].includes(norm)) return "prefix";
  if (["designnumber", "designno", "design", "dno"].includes(norm)) return "designNumber";
  if (["grossweight", "grossweightg", "grosswt", "grosswtg", "gross", "gwt"].includes(norm))
    return "grossWeight";
  if (["netweight", "netweightg", "netwt", "netwtg", "net", "nwt"].includes(norm))
    return "netWeight";
  if (["stoneweight", "stoneweightg", "stonewt", "stonewtg", "stone", "swt"].includes(norm))
    return "stoneWeight";
  if (["metaltype", "metal"].includes(norm)) return "metalType";
  if (["metalpurity", "purity", "kt", "karat"].includes(norm)) return "metalPurity";
  if (["collectionline", "collection", "line"].includes(norm)) return "collectionLine";
  if (["czreserved1", "cz", "reserved1", "czwt"].includes(norm)) return "reserved1";
  if (["bsreserved3", "bs", "reserved3", "bswt"].includes(norm)) return "reserved3";
  return null;
}

// ── Other helpers ──────────────────────────────────────────────────────────

function makeRow(id: string, initial?: Partial<RowData>): RowData {
  return {
    id,
    prefix: "",
    referenceSku: "",
    designNumber: "",
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

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Excel Export ───────────────────────────────────────────────────────────

async function downloadBatchExcel(
  entries: { row: RowData; displaySku: string; result: JobResult | null }[]
) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "BJ Cloud Printer";
  wb.created = new Date();
  const ws = wb.addWorksheet("Print Jobs");

  const headerFill = {
    type: "pattern" as const,
    pattern: "solid" as const,
    fgColor: { argb: "FF1A1A2E" },
  };
  const headerFont = { bold: true, color: { argb: "FFFBBF24" }, size: 10 };

  ws.columns = [
    { header: "Sr No", key: "srNo", width: 8 },
    { header: "New SKU Number", key: "sku", width: 18 },
    { header: "Item Type", key: "prefix", width: 12 },
    { header: "Design Number", key: "designNumber", width: 18 },
    { header: "Previous/Repeat SKU", key: "referenceSku", width: 20 },
    { header: "Gross Weight", key: "grossWeight", width: 14 },
    { header: "Net Weight", key: "netWeight", width: 14 },
    { header: "Stone Weight", key: "stoneWeight", width: 14 },
    { header: "Metal Type", key: "metalType", width: 14 },
    { header: "Metal Purity", key: "metalPurity", width: 14 },
    { header: "Collection Line", key: "collectionLine", width: 18 },
    { header: "CZ (Reserved 1)", key: "reserved1", width: 16 },
    { header: "BS (Reserved 3)", key: "reserved3", width: 16 },
    { header: "Job ID", key: "jobId", width: 38 },
    { header: "Status", key: "status", width: 18 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = { bottom: { style: "thin", color: { argb: "FFFBBF24" } } };
  });
  headerRow.height = 22;

  entries.forEach(({ row, displaySku, result }, i) => {
    ws.addRow({
      srNo: i + 1,
      sku: result?.status === "success" ? result.sku : displaySku || "—",
      prefix: row.prefix,
      designNumber: row.designNumber || "",
      referenceSku: row.referenceSku || "—",
      grossWeight: row.grossWeight ? Number(row.grossWeight) : "",
      netWeight: row.netWeight ? Number(row.netWeight) : "",
      stoneWeight: row.stoneWeight ? Number(row.stoneWeight) : "",
      metalType: row.metalType || "",
      metalPurity: row.metalPurity || "",
      collectionLine: row.collectionLine || "",
      reserved1: row.reserved1 || "",
      reserved3: row.reserved3 || "",
      jobId: result?.status === "success" ? result.jobId : "—",
      status:
        result?.status === "success"
          ? result.mqttStatus
          : result?.status === "error"
            ? `ERROR: ${result.message}`
            : "PENDING",
    });
  });

  ws.eachRow((r, ri) => {
    if (ri === 1) return;
    r.height = 18;
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
  a.download = `print-jobs-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Sample Template Download ───────────────────────────────────────────────

async function downloadSampleExcelTemplate() {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "BJ Cloud Printer";
  wb.created = new Date();
  const ws = wb.addWorksheet("Import Template");

  const headerFill = {
    type: "pattern" as const,
    pattern: "solid" as const,
    fgColor: { argb: "FF1A1A2E" },
  };
  const headerFont = { bold: true, color: { argb: "FFFBBF24" }, size: 10 };

  ws.columns = [
    { header: "Previous SKU (Optional)", key: "referenceSku", width: 24 },
    { header: "Item Type", key: "prefix", width: 14 },
    { header: "Design Number", key: "designNumber", width: 18 },
    { header: "Gross Weight", key: "grossWeight", width: 14 },
    { header: "Net Weight", key: "netWeight", width: 14 },
    { header: "Stone Weight", key: "stoneWeight", width: 14 },
    { header: "Metal Type", key: "metalType", width: 14 },
    { header: "Metal Purity", key: "metalPurity", width: 14 },
    { header: "Collection Line", key: "collectionLine", width: 18 },
    { header: "CZ (Reserved 1)", key: "reserved1", width: 16 },
    { header: "BS (Reserved 3)", key: "reserved3", width: 16 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = { bottom: { style: "thin", color: { argb: "FFFBBF24" } } };
  });
  headerRow.height = 24;

  // Sample row 1: Repeat order example (uses previous SKU to auto-fill details, brand new SKU generated on print)
  ws.addRow({
    referenceSku: "TRTP5614",
    prefix: "TRTP",
    designNumber: "DZGR35196",
    grossWeight: 12.45,
    netWeight: 11.2,
    stoneWeight: 1.25,
    metalType: "Gold",
    metalPurity: "22K",
    collectionLine: "Bridal",
    reserved1: "10",
    reserved3: "2",
  });

  // Sample row 2: New order example
  ws.addRow({
    referenceSku: "",
    prefix: "RING",
    designNumber: "DZRN1002",
    grossWeight: 8.5,
    netWeight: 8.1,
    stoneWeight: 0.4,
    metalType: "Gold",
    metalPurity: "18K",
    collectionLine: "Classic",
    reserved1: "4",
    reserved3: "0",
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
    async (dn: string) => {
      const trimmed = dn.trim();
      if (!trimmed) {
        onChange({ imageUrl: undefined });
        return;
      }
      onChange({ imageLoading: true });
      try {
        const res = await fetch(
          `/api/catalog/design/${encodeURIComponent(trimmed)}`
        );
        const data = await res.json();
        if (res.ok && data.data) {
          const item = data.data;
          onChange({
            imageUrl: item.imageUrl,
            grossWeight: String(item.grossWeight ?? ""),
            netWeight: String(item.netWeight ?? ""),
            stoneWeight: String(item.stoneWeight ?? ""),
            metalType: item.metalType ?? "",
            metalPurity: item.metalPurity ?? "",
            collectionLine: item.collectionLine ?? "",
            reserved1: String(item.reserved1 ?? ""),
            reserved3: String(item.reserved3 ?? ""),
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
    onChange({ designNumber: val });
    if (designTimer.current) clearTimeout(designTimer.current);
    designTimer.current = setTimeout(() => fetchImage(val), 800);
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
          {row.referenceSku && (
            <Badge
              variant="outline"
              className="text-[10px] py-0 px-1.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30"
            >
              Repeat of {row.referenceSku}
            </Badge>
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
              {/* Row 1: Item type + Previous SKU + Design number */}
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

                <Field label="Previous SKU (Optional)" id={id("refSku")}>
                  <Input
                    id={id("refSku")}
                    value={row.referenceSku ?? ""}
                    onChange={(e) => {
                      const val = e.target.value.toUpperCase().trim();
                      onChange({
                        referenceSku: val,
                        prefix: row.prefix || (val ? val.replace(/\d+$/, "") : ""),
                      });
                    }}
                    placeholder="e.g. TRTP5614"
                    className="h-10 font-mono uppercase"
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
                    onChange={(e) => onChange({ grossWeight: e.target.value })}
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
                    onChange={(e) => onChange({ stoneWeight: e.target.value })}
                    placeholder="0.000"
                    className="h-10"
                    disabled={done || isSubmitting}
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
                    onChange={(e) => onChange({ netWeight: e.target.value })}
                    placeholder="0.000"
                    className="h-10"
                    disabled={done || isSubmitting}
                  />
                </Field>
                <Field label="Metal Type" id={id("metal")}>
                  <Input
                    id={id("metal")}
                    value={row.metalType}
                    onChange={(e) => onChange({ metalType: e.target.value })}
                    placeholder="Gold, Silver…"
                    className="h-10"
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
                    onChange={(e) => onChange({ metalPurity: e.target.value })}
                    placeholder="22K, 18K…"
                    className="h-10"
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
                    onChange={(e) => onChange({ reserved1: e.target.value })}
                    placeholder="e.g. 12"
                    className="h-10"
                    disabled={done || isSubmitting}
                  />
                </Field>
                <Field label="BS (Reserved 3)" id={id("reserved3")}>
                  <Input
                    id={id("reserved3")}
                    value={row.reserved3}
                    onChange={(e) => onChange({ reserved3: e.target.value })}
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
                    {row.referenceSku
                      ? `New SKU for repeat order (${row.referenceSku})`
                      : "Assigned sequentially on submit"}
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
                      alt={row.designNumber || row.referenceSku || "Product Image"}
                      className="max-h-56 max-w-full rounded-lg object-contain shadow-lg ring-1 ring-border/20"
                    />
                    <span className="mt-2 text-[10px] font-mono text-muted-foreground">
                      {row.designNumber || row.referenceSku}
                    </span>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-2 text-center">
                    <ImageOff className="h-8 w-8 text-muted-foreground/30" />
                    <p className="text-xs text-muted-foreground/60">
                      {row.designNumber || row.referenceSku
                        ? "Design image not found"
                        : "Enter design number or previous SKU to view image"}
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
    setRows((prev) => [...prev, makeRow(uid())]);
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
        const rawPrefix = (rowValues.prefix || "").toUpperCase().trim();
        const effectivePrefix =
          rawPrefix || (rawRefSku ? rawRefSku.replace(/\d+$/, "").toUpperCase() : "");

        parsedRows.push(
          makeRow(uid(), {
            referenceSku: rawRefSku,
            prefix: effectivePrefix,
            designNumber: (rowValues.designNumber || "").trim(),
            grossWeight: (rowValues.grossWeight || "").trim(),
            netWeight: (rowValues.netWeight || "").trim(),
            stoneWeight: (rowValues.stoneWeight || "").trim(),
            metalType: (rowValues.metalType || "").trim(),
            metalPurity: (rowValues.metalPurity || "").trim(),
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
        .filter((r) => r.referenceSku || r.designNumber)
        .map((r) => ({
          sku: r.referenceSku || undefined,
          designNumber: r.designNumber || undefined,
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
                    : null);

                if (!match) return r;

                return {
                  ...r,
                  imageUrl: r.imageUrl || match.imageUrl,
                  prefix: r.prefix || match.prefix || match.itemType || "",
                  designNumber: r.designNumber || match.designNumber || "",
                  grossWeight:
                    r.grossWeight ||
                    (match.grossWeight != null ? String(match.grossWeight) : ""),
                  netWeight:
                    r.netWeight ||
                    (match.netWeight != null ? String(match.netWeight) : ""),
                  stoneWeight:
                    r.stoneWeight ||
                    (match.stoneWeight != null ? String(match.stoneWeight) : ""),
                  metalType: r.metalType || match.metalType || "",
                  metalPurity: r.metalPurity || match.metalPurity || "",
                  collectionLine: r.collectionLine || match.collectionLine || "",
                  reserved1: r.reserved1 || match.reserved1 || "",
                  reserved3: r.reserved3 || match.reserved3 || "",
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

  // ── Submit ───────────────────────────────────────────────────────────────

  function handleSubmit() {
    const err = validateAll();
    if (err) {
      toast.error(err);
      return;
    }

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
              grossWeight: row.grossWeight ? Number(row.grossWeight) : undefined,
              netWeight: row.netWeight ? Number(row.netWeight) : undefined,
              stoneWeight: row.stoneWeight ? Number(row.stoneWeight) : undefined,
              metalType: row.metalType || undefined,
              metalPurity: row.metalPurity || undefined,
              collectionLine: row.collectionLine || undefined,
              imageUrl: row.imageUrl || undefined,
              reserved1: row.reserved1 || undefined,
              reserved3: row.reserved3 || undefined,
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
            // Update cache so next batch row preview reflects the newly committed SKU
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
        toast.success(`${ok} job${ok > 1 ? "s" : ""} created with new unique SKUs.`);
      else if (ok === 0) toast.error(`All ${fail} jobs failed.`);
      else toast.warning(`${ok} succeeded, ${fail} failed.`);
    });
  }

  // ── Excel Export ─────────────────────────────────────────────────────────

  async function handleExcel() {
    const entries = rows.map((row, i) => ({
      row,
      displaySku: computeDisplaySku(i),
      result: results.get(row.id) ?? null,
    }));
    try {
      await downloadBatchExcel(entries);
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
    <div className="flex-1 overflow-auto">
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
          <p className="mt-0.5 text-xs text-muted-foreground">
            Print single items, repeat orders, or upload an Excel sheet — a new sequential SKU is assigned to every label
          </p>
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
            title="Download sample Excel template"
          >
            <Download className="h-3.5 w-3.5" />
            Template
          </Button>

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

      <div className="max-w-6xl space-y-4 px-8 py-8">
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
                  Import Excel for Repeat Orders & Batch Printing
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                </p>
                <p className="text-xs text-muted-foreground">
                  Upload an Excel (.xlsx) file containing past SKUs or design numbers. Product details & images auto-fill, and new unique SKUs are generated for printing.
                </p>
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
                Upload Sheet
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs text-muted-foreground"
                onClick={downloadSampleExcelTemplate}
              >
                <Download className="h-3.5 w-3.5" />
                Sample Template
              </Button>
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

        {/* ── Bottom action bar ── */}
        <div className="flex flex-wrap items-center gap-3 pt-2">
          {/* Add item — always visible unless done */}
          {!allDone && (
            <Button
              type="button"
              variant="outline"
              className="gap-2 border-dashed"
              onClick={addRow}
              disabled={isPending}
            >
              <Plus className="h-4 w-4" />
              Add Item
            </Button>
          )}

          {/* Excel — always available once there's any prefix */}
          {hasAnyPrefix && (
            <Button
              type="button"
              variant="outline"
              className="gap-2 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
              onClick={handleExcel}
              disabled={isPending}
            >
              <FileSpreadsheet className="h-4 w-4" />
              Download Excel
            </Button>
          )}

          <div className="flex-1" />

          {/* Done actions */}
          {allDone ? (
            <>
              <Button
                variant="outline"
                onClick={() => router.push("/dashboard")}
              >
                View All Jobs
              </Button>
              <Button className="gap-2" onClick={handleReset}>
                <Printer className="h-4 w-4" />
                New Batch
              </Button>
            </>
          ) : (
            <Button
              id="submit-batch-btn"
              className="gap-2 min-w-36"
              onClick={handleSubmit}
              disabled={isPending || !hasAnyPrefix}
            >
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {results.size + 1} / {rows.length}…
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
  );
}
