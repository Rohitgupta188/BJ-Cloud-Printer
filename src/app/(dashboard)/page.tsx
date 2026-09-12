"use client";

import { useState, useEffect, useCallback, useTransition } from "react";
import Link from "next/link";
import {
  Printer,
  CheckCircle2,
  Clock,
  AlertCircle,
  HelpCircle,
  RefreshCw,
  XCircle,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

// ─── Types ────────────────────────────────────────────────────────────────────

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
  payloadType: string;
  status: PrintJobStatus;
  createdAt: string;
  retryCount: number;
  lastError?: string;
}

interface JobsData {
  jobs: PrintJob[];
  total: number;
  page: number;
  pages: number;
}

// ─── Status configuration ─────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  PrintJobStatus,
  { label: string; textClass: string; bgClass: string; borderClass: string }
> = {
  PENDING: {
    label: "Pending",
    textClass: "text-blue-400",
    bgClass: "bg-blue-400/10",
    borderClass: "border-blue-400/25",
  },
  MQTT_PUBLISHED: {
    label: "Sent to Printer",
    textClass: "text-amber-400",
    bgClass: "bg-amber-400/10",
    borderClass: "border-amber-400/25",
  },
  MQTT_FAILED: {
    label: "Send Failed",
    textClass: "text-red-400",
    bgClass: "bg-red-400/10",
    borderClass: "border-red-400/25",
  },
  AGENT_RECEIVED: {
    label: "Agent Received",
    textClass: "text-amber-400",
    bgClass: "bg-amber-400/10",
    borderClass: "border-amber-400/25",
  },
  COMPLETED: {
    label: "Completed",
    textClass: "text-emerald-400",
    bgClass: "bg-emerald-400/10",
    borderClass: "border-emerald-400/25",
  },
  FAILED: {
    label: "Failed",
    textClass: "text-red-400",
    bgClass: "bg-red-400/10",
    borderClass: "border-red-400/25",
  },
  UNKNOWN: {
    label: "Unknown",
    textClass: "text-slate-400",
    bgClass: "bg-slate-400/10",
    borderClass: "border-slate-400/25",
  },
};

function StatusBadge({ status }: { status: PrintJobStatus }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.UNKNOWN;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border ${cfg.textClass} ${cfg.bgClass} ${cfg.borderClass}`}
    >
      {cfg.label}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ─── Stats strip data ─────────────────────────────────────────────────────────

function computeStats(jobs: PrintJob[]) {
  return {
    pending: jobs.filter((j) => j.status === "PENDING").length,
    sent: jobs.filter(
      (j) => j.status === "MQTT_PUBLISHED" || j.status === "AGENT_RECEIVED"
    ).length,
    completed: jobs.filter((j) => j.status === "COMPLETED").length,
    failed: jobs.filter(
      (j) =>
        j.status === "FAILED" ||
        j.status === "UNKNOWN" ||
        j.status === "MQTT_FAILED"
    ).length,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [data, setData] = useState<JobsData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [isLoading, setIsLoading] = useState(true);

  const fetchJobs = useCallback(async () => {
    setIsLoading(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/print-jobs?limit=50&page=1", {
        cache: "no-store",
      });

      if (!res.ok) {
        if (res.status === 401) {
          setFetchError("Session expired. Please refresh the page.");
        } else {
          setFetchError(`Failed to load jobs (HTTP ${res.status})`);
        }
        return;
      }

      const json = await res.json();
      setData(json.data as JobsData);
    } catch {
      setFetchError("Network error — could not reach the server.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // fetchJobs is a stable useCallback ([] deps) — setState is only called inside
  // async callbacks, not synchronously. The linter can't see through the indirection.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const jobs = data?.jobs ?? [];
  const stats = computeStats(jobs);

  const STAT_CARDS = [
    {
      label: "Pending",
      value: stats.pending,
      icon: Clock,
      color: "text-blue-400",
      bg: "bg-blue-400/10",
    },
    {
      label: "Sent / Received",
      value: stats.sent,
      icon: Wifi,
      color: "text-amber-400",
      bg: "bg-amber-400/10",
    },
    {
      label: "Completed",
      value: stats.completed,
      icon: CheckCircle2,
      color: "text-emerald-400",
      bg: "bg-emerald-400/10",
    },
    {
      label: "Failed",
      value: stats.failed,
      icon: AlertCircle,
      color: "text-red-400",
      bg: "bg-red-400/10",
    },
  ];

  return (
    <div className="flex-1 overflow-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-border/50 px-8 py-5 flex items-center justify-between bg-background/80 backdrop-blur-sm">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Print Jobs</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isLoading
              ? "Loading…"
              : data
              ? `${data.total} total job${data.total !== 1 ? "s" : ""}`
              : "Cloud-side lifecycle tracking"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            id="refresh-jobs-btn"
            variant="outline"
            size="icon"
            onClick={() => startTransition(() => { fetchJobs(); })}
            disabled={isLoading}
            className="text-muted-foreground"
            title="Refresh jobs"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
          <Button id="new-print-job-btn" asChild className="gap-2">
            <Link href="/print">
              <Printer className="w-4 h-4" />
              New Print Job
            </Link>
          </Button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="px-8 pt-6 pb-2 grid grid-cols-2 lg:grid-cols-4 gap-4">
        {STAT_CARDS.map(({ label, value, icon: Icon, color, bg }) => (
          <Card key={label} className="border-border/40">
            <CardContent className="p-4 flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg ${bg} flex items-center justify-center shrink-0`}>
                <Icon className={`w-4 h-4 ${color}`} />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] text-muted-foreground truncate">{label}</p>
                <p className="text-2xl font-bold leading-none mt-1">
                  {isLoading ? (
                    <span className="text-muted-foreground text-sm">…</span>
                  ) : (
                    value
                  )}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Separator className="mx-8 mt-4 opacity-40 w-auto" />

      {/* Jobs table */}
      <div className="px-8 py-6">
        <Card className="border-border/40">
          <CardHeader className="py-4 px-5 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-semibold">Recent Jobs</CardTitle>
            {data && data.total > 0 && (
              <span className="text-xs text-muted-foreground">
                Showing {jobs.length} of {data.total}
              </span>
            )}
          </CardHeader>

          <CardContent className="p-0">
            {/* Error state */}
            {fetchError && (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <WifiOff className="w-5 h-5 text-destructive" />
                </div>
                <p className="text-sm text-muted-foreground">{fetchError}</p>
                <Button variant="outline" size="sm" onClick={fetchJobs}>
                  Try again
                </Button>
              </div>
            )}

            {/* Loading skeleton */}
            {isLoading && !fetchError && (
              <div className="flex items-center justify-center py-14">
                <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {/* Empty state */}
            {!isLoading && !fetchError && jobs.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center px-8">
                <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
                  <HelpCircle className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-semibold">No print jobs yet</p>
                <p className="text-xs text-muted-foreground mt-1.5 max-w-xs leading-relaxed">
                  Create your first print job to generate a SKU and queue it
                  for the TSC TTP-244 Pro printer.
                </p>
                <Button asChild size="sm" className="mt-5 gap-2">
                  <Link href="/print">
                    <Printer className="w-3.5 h-3.5" />
                    Create first job
                  </Link>
                </Button>
              </div>
            )}

            {/* Table */}
            {!isLoading && !fetchError && jobs.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/40">
                      {[
                        "SKU",
                        "Job ID",
                        "Printer",
                        "Type",
                        "Status",
                        "Retries",
                        "Created",
                      ].map((h) => (
                        <th
                          key={h}
                          className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-4 py-3"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((job) => (
                      <tr
                        key={job.jobId}
                        className="border-b border-border/25 hover:bg-muted/20 transition-colors group"
                      >
                        <td className="px-4 py-3.5 font-mono font-semibold text-primary">
                          {job.sku}
                        </td>
                        <td className="px-4 py-3.5 font-mono text-[11px] text-muted-foreground">
                          <span title={job.jobId}>
                            {job.jobId.slice(0, 8)}…
                          </span>
                        </td>
                        <td className="px-4 py-3.5 text-muted-foreground text-xs">
                          {job.printerId}
                        </td>
                        <td className="px-4 py-3.5">
                          <span className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded border border-border/50">
                            {job.payloadType}
                          </span>
                        </td>
                        <td className="px-4 py-3.5">
                          <StatusBadge status={job.status} />
                        </td>
                        <td className="px-4 py-3.5 text-xs text-muted-foreground">
                          {job.retryCount > 0 ? (
                            <span className="flex items-center gap-1 text-amber-400">
                              <XCircle className="w-3 h-3" />
                              {job.retryCount}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-xs text-muted-foreground">
                          {timeAgo(job.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
