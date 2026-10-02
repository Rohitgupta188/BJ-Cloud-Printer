"use client";

import { useState, useEffect, useRef, useCallback, useTransition, useMemo } from "react";
import Link from "next/link";
import { authFetch } from "@/lib/auth/auth-fetch";
import { csrfHeaders } from "@/lib/security/csrf-client";
import { toast } from "sonner";
import {
  Printer,
  CheckCircle2,
  Clock,
  AlertCircle,
  HelpCircle,
  RefreshCw,
  WifiOff,
  Wifi,
  FileSpreadsheet,
  Search,
  Download,
  RotateCcw,
  Check,
  Minus,
  X,
  ChevronDown,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type PrintJobStatus =
  | "PENDING"
  | "MQTT_PUBLISHED"
  | "MQTT_FAILED"
  | "AGENT_RECEIVED"
  | "COMPLETED"
  | "FAILED"
  | "UNKNOWN";

interface PrintJob {
  jobId: string;
  sku: string;
  printerId: string;
  payloadType: "TSPL" | "ZPL";
  payload: string;
  status: PrintJobStatus;
  mqttPublishedAt?: string;
  retryCount: number;
  lastError?: string;
  createdBy: string;
  // jewellery metadata
  itemType?: string;
  designNumber?: string;
  imageName?: string;
  itemStatus?: string;
  grossWeight?: number;
  netWeight?: number;
  stoneWeight?: number;
  metalType?: string;
  metalPurity?: string;
  collectionLine?: string;
  imageUrl?: string;
  reserved1?: string;
  reserved3?: string;
  // timestamps
  createdAt: string;
  updatedAt: string;
}

interface JobsData {
  jobs: PrintJob[];
  total: number;
  page: number;
  pages: number;
}

const STATUS_CFG: Record<PrintJobStatus, { label: string; dot: string; badge: string }> = {
  PENDING:        { label: "Pending",        dot: "bg-blue-400",    badge: "text-blue-400 bg-blue-400/10 border-blue-400/25" },
  MQTT_PUBLISHED: { label: "Sent",           dot: "bg-amber-400",   badge: "text-amber-400 bg-amber-400/10 border-amber-400/25" },
  MQTT_FAILED:    { label: "Send Failed",    dot: "bg-red-400",     badge: "text-red-400 bg-red-400/10 border-red-400/25" },
  AGENT_RECEIVED: { label: "Agent Rcvd",     dot: "bg-amber-400",   badge: "text-amber-400 bg-amber-400/10 border-amber-400/25" },
  COMPLETED:      { label: "Completed",      dot: "bg-emerald-400", badge: "text-emerald-400 bg-emerald-400/10 border-emerald-400/25" },
  FAILED:         { label: "Failed",         dot: "bg-red-400",     badge: "text-red-400 bg-red-400/10 border-red-400/25" },
  UNKNOWN:        { label: "Unknown",        dot: "bg-slate-500",   badge: "text-slate-400 bg-slate-400/10 border-slate-400/25" },
};

function StatusBadge({ status }: { status: PrintJobStatus }) {
  const cfg = STATUS_CFG[status] ?? STATUS_CFG.UNKNOWN;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${cfg.badge}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

// ── Ultra-Modern Custom Checkbox ───────────────────────────────────────────

function ModernCheckbox({
  checked,
  indeterminate,
  onChange,
  title,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={`group relative inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 cursor-pointer ${
        checked || indeterminate
          ? "border-primary bg-primary text-primary-foreground shadow-xs shadow-primary/25"
          : "border-border/80 bg-background/80 hover:border-primary/60 hover:bg-muted/40"
      }`}
    >
      {checked && <Check className="h-3 w-3 stroke-3" />}
      {indeterminate && !checked && <Minus className="h-3 w-3 stroke-3" />}
    </button>
  );
}

// ── Natural Language Relative Time: "1 hour ago, 2 hours ago, 4 days ago" ──

function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";

  const diffMs = Date.now() - d.getTime();
  if (diffMs < 45000 && diffMs >= -5000) {
    return "just now";
  }
  if (diffMs < 0) {
    return "in a moment";
  }

  const s = Math.floor(diffMs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const day = Math.floor(h / 24);

  if (m < 1) return `${s} seconds ago`;
  if (m === 1) return "1 minute ago";
  if (m < 60) return `${m} minutes ago`;
  if (h === 1) return "1 hour ago";
  if (h < 24) return `${h} hours ago`;
  if (day === 1) return "1 day ago";
  if (day < 7) return `${day} days ago`;
  if (day < 14) return "1 week ago";
  if (day < 30) return `${Math.floor(day / 7)} weeks ago`;
  if (day < 60) return "1 month ago";
  if (day < 365) return `${Math.floor(day / 30)} months ago`;
  if (Math.floor(day / 365) === 1) return "1 year ago";
  return `${Math.floor(day / 365)} years ago`;
}

function formatFullDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString([], {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })} at ${d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  })}`;
}

export default function DashboardPage() {
  const [data, setData] = useState<JobsData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [, startTransition] = useTransition();

  // Selection & Search state
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [isPrintingSelected, setIsPrintingSelected] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  // Multi-Printer selection for reprinting
  const [printers, setPrinters] = useState<{ id: string; name: string; isDefault?: boolean }[]>([
    { id: "mumbai-01", name: "Mumbai Printer 01", isDefault: true },
    { id: "mumbai-02", name: "Mumbai Printer 02", isDefault: false },
  ]);
  const [reprintPrinterId, setReprintPrinterId] = useState<string>("mumbai-01");
  const [isPrinterDropdownOpen, setIsPrinterDropdownOpen] = useState(false);
  const printerDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isPrinterDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (printerDropdownRef.current && !printerDropdownRef.current.contains(e.target as Node)) {
        setIsPrinterDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isPrinterDropdownOpen]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("bj_selected_printer_id");
      if (saved) setReprintPrinterId(saved);
    } catch {}

    authFetch("/api/printers")
      .then((r) => r.json())
      .then((data) => {
        if (data?.data?.printers && Array.isArray(data.data.printers) && data.data.printers.length > 0) {
          setPrinters(data.data.printers);
          setReprintPrinterId((current) => {
            const exists = data.data.printers.some((p: { id: string }) => p.id === current);
            if (exists) return current;
            const def = data.data.printers.find((p: { isDefault?: boolean }) => p.isDefault) || data.data.printers[0];
            return def.id;
          });
        }
      })
      .catch((err) => console.error("Failed to load printers:", err));
  }, []);

  const fetchJobs = useCallback(async () => {
    setIsLoading(true);
    setFetchError(null);
    try {
      const res = await authFetch("/api/print-jobs?limit=50", { cache: "no-store" });
      if (!res.ok) {
        setFetchError(
          res.status === 401
            ? "Session expired. Please sign in again."
            : `Server error (HTTP ${res.status})`
        );
        return;
      }
      const json = await res.json();
      setData(json.data);
    } catch {
      setFetchError("Network error — could not reach the server.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  const jobs = useMemo(() => data?.jobs ?? [], [data?.jobs]);

  // Filter jobs based on search query
  const filteredJobs = useMemo(() => {
    if (!searchQuery.trim()) return jobs;
    const q = searchQuery.toLowerCase().trim();
    return jobs.filter(
      (j) =>
        j.sku?.toLowerCase().includes(q) ||
        j.designNumber?.toLowerCase().includes(q) ||
        j.itemType?.toLowerCase().includes(q) ||
        j.metalType?.toLowerCase().includes(q) ||
        j.metalPurity?.toLowerCase().includes(q) ||
        j.jobId?.toLowerCase().includes(q) ||
        j.status?.toLowerCase().includes(q)
    );
  }, [jobs, searchQuery]);

  // Selection helpers
  const isAllSelected =
    filteredJobs.length > 0 && filteredJobs.every((j) => selectedJobIds.has(j.jobId));
  const isSomeSelected =
    filteredJobs.some((j) => selectedJobIds.has(j.jobId)) && !isAllSelected;

  function toggleSelectAll() {
    if (isAllSelected) {
      setSelectedJobIds(new Set());
    } else {
      setSelectedJobIds(new Set(filteredJobs.map((j) => j.jobId)));
    }
  }

  function toggleSelectJob(jobId: string) {
    setSelectedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  // ── Action: Print Selected SKUs (Re-print return labels) ────────────────────
  // async function handlePrintSelected(jobIdsToPrint?: string[], targetPrinterId?: string) {
  //   const ids = jobIdsToPrint ?? Array.from(selectedJobIds);
  //   if (ids.length === 0) {
  //     toast.error("Please select at least one SKU to print.");
  //     return;
  //   }

  //   const effectivePrinterId = targetPrinterId || reprintPrinterId;

  //   setIsPrintingSelected(true);
  //   const toastId = toast.loading(`Sending ${ids.length} job(s) to ${effectivePrinterId}…`);

  //   try {
  //     const res = await authFetch("/api/print-jobs/reprint", {
  //       method: "POST",
  //       headers: { "Content-Type": "application/json", ...csrfHeaders() },
  //       body: JSON.stringify({ jobIds: ids, printerId: effectivePrinterId }),
  //     });

  //     const json = await res.json();
  //     if (!res.ok) {
  //       toast.error(json.error || "Failed to print selected jobs", { id: toastId });
  //       return;
  //     }

  //     toast.success(
  //       `Sent ${json.data.reprinted} SKU(s) to ${effectivePrinterId}!`,
  //       { id: toastId }
  //     );

  //     // Refresh job list to update status in table
  //     fetchJobs();
  //   } catch {
  //     toast.error("Network error while trying to print.", { id: toastId });
  //   } finally {
  //     setIsPrintingSelected(false);
  //   }
  // }

  // ── Action: Download Selected SKUs as Excel ────────────────────────────────
  async function handleDownloadExcel(jobsToDownload?: PrintJob[]) {
    const targetJobs =
      jobsToDownload ?? jobs.filter((j) => selectedJobIds.has(j.jobId));
    if (targetJobs.length === 0) {
      toast.error("Please select at least one SKU to download.");
      return;
    }

    setIsDownloading(true);
    const toastId = toast.loading(`Generating Excel for ${targetJobs.length} SKU(s)…`);

    try {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = "BJ Cloud Printer";
      wb.created = new Date();
      const ws = wb.addWorksheet("Return SKUs");

      ws.columns = [
        { header: "RFID Tag", key: "rfidTag", width: 18 },
        { header: "SKU Number", key: "skuNumber", width: 18 },
        { header: "Design Number", key: "designNumber", width: 18 },
        { header: "Image Name", key: "imageName", width: 22 },
        { header: "Item Status", key: "itemStatus", width: 14 },
        { header: "Sales Man Name", key: "salesManName", width: 16 },
        { header: "Item Type", key: "itemType", width: 14 },
        { header: "Size", key: "size", width: 10 },
        { header: "Gross Weight", key: "grossWeight", width: 14 },
        { header: "Net Weight", key: "netWeight", width: 14 },
        { header: "Collection Line", key: "collectionLine", width: 18 },
        { header: "Item Category", key: "itemCategory", width: 16 },
        { header: "Metal Type", key: "metalType", width: 14 },
        { header: "Metal Purity", key: "metalPurity", width: 14 },
        { header: "Metal Weight", key: "metalWeight", width: 14 },
        { header: "Total Diamond Weight", key: "totalDiamondWeight", width: 20 },
        { header: "Total Stone Weight", key: "totalStoneWeight", width: 18 },
        { header: "Stone Weight", key: "stoneWeight", width: 14 },
        { header: "Selling Price", key: "sellingPrice", width: 14 },
        { header: "CZ Wt", key: "czWt", width: 12 },
        { header: "Reserved 2", key: "reserved2", width: 14 },
        { header: "BS Wt", key: "bsWt", width: 12 },
        { header: "CS Wt", key: "csWt", width: 12 },
        { header: "Printer ID", key: "printerId", width: 18 },
        { header: "Status", key: "status", width: 16 },
        { header: "Created At", key: "createdAt", width: 22 },
      ];

      const headerRow = ws.getRow(1);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF0F172A" },
        };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      });
      headerRow.height = 24;

      targetJobs.forEach((job) => {
        const prefix = job.sku.includes("-") ? job.sku.split("-")[0] : "";
        ws.addRow({
          rfidTag: job.sku,
          skuNumber: job.sku,
          designNumber: job.designNumber || "",
          imageName:
            job.imageName || (job.designNumber ? `${job.designNumber}.jpg` : ""),
          itemStatus: job.itemStatus || "RETURNED",
          salesManName: "",
          itemType: job.itemType || prefix,
          size: "",
          grossWeight: job.grossWeight ?? "",
          netWeight: job.netWeight ?? "",
          collectionLine: job.collectionLine || "",
          itemCategory: "",
          metalType: job.metalType || "",
          metalPurity: job.metalPurity || "",
          metalWeight: job.netWeight ?? "",
          totalDiamondWeight: "",
          totalStoneWeight: job.stoneWeight ?? "",
          stoneWeight: job.stoneWeight ?? "",
          sellingPrice: "",
          czWt: job.reserved1 || "",
          reserved2: "",
          bsWt: job.reserved3 || "",
          csWt: "",
          printerId: job.printerId,
          status: job.status,
          createdAt: new Date(job.createdAt).toLocaleString(),
        });
      });

      ws.eachRow((r, ri) => {
        if (ri === 1) return;
        r.height = 20;
        r.eachCell((cell) => {
          cell.alignment = { vertical: "middle", horizontal: "center" };
        });
      });

      const dateStr = new Date().toISOString().slice(0, 10);
      const fileName = `BJ_Return_SKUs_${dateStr}_${targetJobs.length}items.xlsx`;

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

      toast.success(`Downloaded ${targetJobs.length} SKU(s) to ${fileName}`, {
        id: toastId,
      });
    } catch (err) {
      console.error("Excel generation error", err);
      toast.error("Failed to generate Excel file", { id: toastId });
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <div className="flex-1 overflow-auto pb-24">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/50 bg-background/80 px-8 py-5 backdrop-blur-sm">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Print Jobs & SKU Return</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isLoading
              ? "Loading…"
              : data
              ? `${data.total} total job${data.total !== 1 ? "s" : ""}`
              : "Live job status"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {jobs.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleDownloadExcel(jobs)}
              disabled={isDownloading || isLoading}
              className="gap-1.5 text-xs border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
              title="Download all jobs to Excel"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              Export All
            </Button>
          )}
          <Button
            id="refresh-btn"
            variant="outline"
            size="icon"
            onClick={() => startTransition(() => { fetchJobs(); })}
            disabled={isLoading}
            className="text-muted-foreground"
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
          <Button id="new-job-btn" asChild className="gap-2">
            <Link href="/print">
              <Printer className="h-4 w-4" />
              New Print Job
            </Link>
          </Button>
        </div>
      </div>

      {/* ── Jobs table ─────────────────────────────────────────────────────── */}
      <div className="px-8 py-6">
        <Card className="border-border/40 overflow-hidden shadow-xs">
          <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 border-b border-border/30">
            <div className="flex items-center gap-3">
              <CardTitle className="text-sm font-semibold">Recent Jobs</CardTitle>
              {data && data.total > 0 && (
                <span className="text-xs text-muted-foreground">
                  Showing {filteredJobs.length} of {data.total}
                </span>
              )}
              {selectedJobIds.size > 0 && (
                <span className="rounded-full bg-primary/10 border border-primary/20 px-2.5 py-0.5 text-[11px] font-semibold text-primary">
                  {selectedJobIds.size} selected
                </span>
              )}
            </div>

            {/* Search Input for SKU Return lookup */}
            <div className="relative flex items-center w-full sm:w-72">
              <Search className="absolute left-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search SKU or Design No…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8 text-xs font-mono"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  ✕
                </button>
              )}
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {fetchError ? (
              <div className="flex flex-col items-center justify-center gap-3 py-12">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
                  <WifiOff className="h-5 w-5 text-destructive" />
                </div>
                <p className="text-sm text-muted-foreground">{fetchError}</p>
                <Button variant="outline" size="sm" onClick={fetchJobs}>
                  Retry
                </Button>
              </div>
            ) : isLoading ? (
              <div className="flex items-center justify-center py-14">
                <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : filteredJobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-8 py-16 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
                  <HelpCircle className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-semibold">
                  {searchQuery ? "No matching jobs found" : "No print jobs yet"}
                </p>
                <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">
                  {searchQuery
                    ? `No records found matching "${searchQuery}". Clear your search query to see all jobs.`
                    : "Create your first print job to generate a SKU and queue it for the TSC TTP-244 Pro."}
                </p>
                {searchQuery ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4 text-xs"
                    onClick={() => setSearchQuery("")}
                  >
                    Clear Search
                  </Button>
                ) : (
                  <Button asChild size="sm" className="mt-5 gap-2">
                    <Link href="/print">
                      <Printer className="h-3.5 w-3.5" />
                      Create first job
                    </Link>
                  </Button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-275 table-fixed text-sm">
                  <thead>
                    <tr className="border-b border-border/40 bg-muted/20">
                      <th className="w-12 px-4 py-3 text-center">
                        <ModernCheckbox
                          checked={isAllSelected}
                          indeterminate={isSomeSelected}
                          onChange={toggleSelectAll}
                          title={isAllSelected ? "Deselect all" : "Select all visible"}
                        />
                      </th>
                      <th className="w-[9.5%] px-4 py-3 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                        SKU
                      </th>
                      <th className="w-[9.5%] px-4 py-3 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                        Design No
                      </th>
                      <th className="w-[9.5%] px-4 py-3 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                        Item Type
                      </th>
                      <th className="w-[9.5%] px-4 py-3 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                        G. Wt
                      </th>
                      <th className="w-[9.5%] px-4 py-3 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                        N. Wt
                      </th>
                      <th className="w-[9.5%] px-4 py-3 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                        Purity
                      </th>
                      <th className="w-[9.5%] px-4 py-3 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                        Printer
                      </th>
                      <th className="w-[9.5%] px-4 py-3 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                        Status
                      </th>
                      <th className="w-[9.5%] px-4 py-3 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                        Retries
                      </th>
                      <th className="w-[9.5%] px-4 py-3 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                        Created
                      </th>
                      {/* <th className="w-14 px-4 py-3 text-center text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                        Actions
                      </th> */}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredJobs.map((job) => {
                      const isSelected = selectedJobIds.has(job.jobId);
                      const itemTypeVal =
                        job.itemType || (job.sku.includes("-") ? job.sku.split("-")[0] : "");
                      return (
                        <tr
                          key={job.jobId}
                          className={`border-b border-border/25 transition-all ${
                            isSelected
                              ? "bg-primary/5 border-l-3 border-l-primary hover:bg-primary/8"
                              : "border-l-3 border-l-transparent hover:bg-muted/20"
                          }`}
                        >
                          {/* Row Checkbox */}
                          <td className="px-4 py-3.5 text-center">
                            <ModernCheckbox
                              checked={isSelected}
                              onChange={() => toggleSelectJob(job.jobId)}
                            />
                          </td>

                          {/* SKU */}
                          <td className="px-4 py-3.5 text-left whitespace-nowrap">
                            <span className="text-xs font-semibold text-primary tracking-tight">
                              {job.sku}
                            </span>
                          </td>

                          {/* Design Number */}
                          <td className="px-4 py-3.5 text-left whitespace-nowrap">
                            <span className="text-xs font-medium text-foreground/80">
                              {job.designNumber || <span className="text-muted-foreground/30 font-normal">—</span>}
                            </span>
                          </td>

                          {/* Item Type */}
                          <td className="px-4 py-3.5 text-left whitespace-nowrap">
                            {itemTypeVal ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-muted/70 text-foreground/80 border border-border/50">
                                {itemTypeVal}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/30 text-xs">—</span>
                            )}
                          </td>

                          {/* Gross Weight (G. Wt) */}
                          <td className="px-4 py-3.5 text-left whitespace-nowrap">
                            {job.grossWeight != null && !isNaN(Number(job.grossWeight)) ? (
                              <span className="text-xs tabular-nums font-medium text-foreground/85">
                                {Number(job.grossWeight).toFixed(3)}
                                <span className="text-[10px] text-muted-foreground/60 ml-0.5 font-normal">g</span>
                              </span>
                            ) : (
                              <span className="text-muted-foreground/30 text-xs">—</span>
                            )}
                          </td>

                          {/* Net Weight (N. Wt) */}
                          <td className="px-4 py-3.5 text-left whitespace-nowrap">
                            {job.netWeight != null && !isNaN(Number(job.netWeight)) ? (
                              <span className="text-xs tabular-nums font-medium text-foreground/85">
                                {Number(job.netWeight).toFixed(3)}
                                <span className="text-[10px] text-muted-foreground/60 ml-0.5 font-normal">g</span>
                              </span>
                            ) : (
                              <span className="text-muted-foreground/30 text-xs">—</span>
                            )}
                          </td>

                          {/* Metal Purity */}
                          <td className="px-4 py-3.5 text-left whitespace-nowrap">
                            {job.metalPurity ? (
                              <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium border border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                                {job.metalPurity}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/30 text-xs">—</span>
                            )}
                          </td>

                          {/* Printer */}
                          <td className="px-4 py-3.5 text-left whitespace-nowrap">
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium bg-muted/70 text-foreground/80 border border-border/50">
                              <Printer className="h-3 w-3 text-primary/70" />
                              {job.printerId || "mumbai-01"}
                            </span>
                          </td>

                          {/* Status */}
                          <td className="px-4 py-3.5 text-left whitespace-nowrap">
                            <StatusBadge status={job.status} />
                          </td>

                          {/* Retries */}
                          <td className="px-4 py-3.5 text-left text-xs whitespace-nowrap">
                            {job.retryCount > 0 ? (
                              <span className="inline-flex items-center gap-1 text-amber-500 font-medium">
                                <RotateCcw className="h-3 w-3" />
                                {job.retryCount}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/30">—</span>
                            )}
                          </td>

                          {/* Created: "1 hour ago, 2 hours ago, 4 days ago" */}
                          <td
                            className="px-4 py-3.5 text-left text-xs text-muted-foreground whitespace-nowrap"
                            title={formatFullDateTime(job.createdAt)}
                          >
                            <span>
                              {formatRelativeTime(job.createdAt)}
                            </span>
                          </td>

                          {/* Actions: Quick Reprint
                          <td className="px-4 py-3.5 text-center whitespace-nowrap">
                            <div className="flex items-center justify-center">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-md transition-colors"
                                onClick={() =>
                                  handlePrintSelected([job.jobId], job.printerId || reprintPrinterId)
                                }
                                disabled={isPrintingSelected}
                                title="Print this SKU tag"
                              >
                                <Printer className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </td> */}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Modern Floating Selection Dock ───────────────────────────────── */}
      {selectedJobIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3.5 rounded-2xl border border-primary/25 bg-background/95 px-4.5 py-2.5 shadow-2xl backdrop-blur-xl ring-1 ring-black/10 dark:ring-white/10 animate-in slide-in-from-bottom-5 fade-in duration-200">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full bg-primary/10 border border-primary/25 px-2.5 py-1 text-xs font-semibold text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              {selectedJobIds.size} Selected
            </span>
            <button
              type="button"
              onClick={toggleSelectAll}
              className="text-xs text-muted-foreground hover:text-foreground font-medium underline underline-offset-2 ml-1"
            >
              {isAllSelected ? "Deselect all" : `Select all (${filteredJobs.length})`}
            </button>
          </div>

          <div className="h-5 w-px bg-border/60" />

          <div className="flex items-center gap-2">
            {/* Download SKU Button */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleDownloadExcel()}
              disabled={isDownloading}
              className="h-8 gap-1.5 rounded-xl border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 text-xs font-medium transition-all"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              {isDownloading ? "Downloading…" : `Download SKU`}
            </Button>

            {/* Target Printer Dropdown */}
            {/* <div ref={printerDropdownRef} className="relative">
              <button
                type="button"
                onClick={() => setIsPrinterDropdownOpen((prev) => !prev)}
                disabled={isPrintingSelected}
                className="flex items-center gap-1.5 h-8 px-2.5 rounded-xl border border-input bg-background hover:bg-accent text-xs font-medium cursor-pointer transition-colors shadow-2xs focus:outline-hidden"
                title="Target printer for reprinting"
              >
                <Printer className="h-3.5 w-3.5 text-primary shrink-0" />
                <span className="font-semibold text-foreground">
                  {printers.find((p) => p.id === reprintPrinterId)?.name || reprintPrinterId}
                </span>
                <ChevronDown
                  className={`h-3 w-3 text-muted-foreground/70 shrink-0 transition-transform duration-200 ${
                    isPrinterDropdownOpen ? "rotate-180 text-primary" : ""
                  }`}
                />
              </button>

              {isPrinterDropdownOpen && (
                <div className="absolute top-full mt-1.5 right-0 min-w-40 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg z-50 animate-in fade-in-0 zoom-in-95 duration-100">
                  {printers.map((p) => {
                    const isSelected = p.id === reprintPrinterId;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setReprintPrinterId(p.id);
                          try {
                            localStorage.setItem("bj_selected_printer_id", p.id);
                          } catch {}
                          setIsPrinterDropdownOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                          isSelected
                            ? "bg-accent text-accent-foreground font-semibold"
                            : "hover:bg-muted/70 text-foreground"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Printer className="h-3 w-3 text-muted-foreground" />
                          {p.name}
                        </span>
                        {isSelected && <Check className="h-3.5 w-3.5 text-primary stroke-[2.5]" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div> */}

            {/* Print Selected Button */}
            {/* <Button
              size="sm"
              onClick={() => handlePrintSelected()}
              disabled={isPrintingSelected}
              className="h-8 gap-1.5 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 text-xs font-semibold shadow-md shadow-primary/25 transition-all"
            >
              {isPrintingSelected ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Printer className="h-3.5 w-3.5" />
              )}
              {isPrintingSelected ? "Sending…" : `Print Selected`}
            </Button> */}

            {/* Close Button */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSelectedJobIds(new Set())}
              className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted ml-0.5"
              title="Clear selection"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
