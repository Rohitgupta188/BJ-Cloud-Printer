"use client";

import { useState, useEffect, useCallback, useTransition } from "react";
import Link from "next/link";
import { authFetch } from "@/lib/auth/auth-fetch";
import {
  Printer,
  CheckCircle2,
  Clock,
  AlertCircle,
  HelpCircle,
  RefreshCw,
  XCircle,
  WifiOff,
  Wifi,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
  designNumber?: string;
  grossWeight?: number;
  netWeight?: number;
  stoneWeight?: number;
  metalType?: string;
  metalPurity?: string;
  collectionLine?: string;
  imageUrl?: string;
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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function DashboardPage() {
  const [data, setData] = useState<JobsData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [, startTransition] = useTransition();

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

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const jobs = data?.jobs ?? [];

  const stats = {
    pending:   jobs.filter((j) => j.status === "PENDING").length,
    sent:      jobs.filter((j) => j.status === "MQTT_PUBLISHED" || j.status === "AGENT_RECEIVED").length,
    completed: jobs.filter((j) => j.status === "COMPLETED").length,
    failed:    jobs.filter((j) => ["FAILED", "UNKNOWN", "MQTT_FAILED"].includes(j.status)).length,
  };

  const STAT_CARDS = [
    { label: "Pending",      value: stats.pending,   Icon: Clock,        color: "text-blue-400",    bg: "bg-blue-400/10"    },
    { label: "In Transit",   value: stats.sent,      Icon: Wifi,         color: "text-amber-400",   bg: "bg-amber-400/10"   },
    { label: "Completed",    value: stats.completed, Icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-400/10" },
    { label: "Failed",       value: stats.failed,    Icon: AlertCircle,  color: "text-red-400",     bg: "bg-red-400/10"     },
  ];

  return (
    <div className="flex-1 overflow-auto">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/50 bg-background/80 px-8 py-5 backdrop-blur-sm">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Print Jobs</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isLoading ? "Loading…" : data ? `${data.total} total job${data.total !== 1 ? "s" : ""}` : "Live job status"}
          </p>
        </div>
        <div className="flex items-center gap-2">
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

      {/* ── Stats ──────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 px-8 pb-2 pt-6 lg:grid-cols-4">
        {STAT_CARDS.map(({ label, value, Icon, color, bg }) => (
          <Card key={label} className="border-border/40">
            <CardContent className="flex items-center gap-3 p-4">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${bg}`}>
                <Icon className={`h-4 w-4 ${color}`} />
              </div>
              <div>
                <p className="truncate text-[11px] text-muted-foreground">{label}</p>
                <p className="mt-0.5 text-2xl font-bold leading-none">
                  {isLoading ? <span className="text-base text-muted-foreground">…</span> : value}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Jobs table ─────────────────────────────────────────────────────── */}
      <div className="px-8 py-6">
        <Card className="border-border/40">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 px-5 py-4">
            <CardTitle className="text-sm font-semibold">Recent Jobs</CardTitle>
            {data && data.total > 0 && (
              <span className="text-xs text-muted-foreground">
                {jobs.length} of {data.total}
              </span>
            )}
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
            ) : jobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-8 py-16 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
                  <HelpCircle className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-semibold">No print jobs yet</p>
                <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">
                  Create your first print job to generate a SKU and queue it for the TSC TTP-244 Pro.
                </p>
                <Button asChild size="sm" className="mt-5 gap-2">
                  <Link href="/print">
                    <Printer className="h-3.5 w-3.5" />
                    Create first job
                  </Link>
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/40">
                      {["SKU", "Job ID", "Printer", "Type", "Status", "Retries", "Created"].map((h) => (
                        <th
                          key={h}
                          className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
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
                        className="border-b border-border/25 transition-colors hover:bg-muted/20"
                      >
                        <td className="px-4 py-3.5 font-mono font-semibold text-primary">
                          {job.sku}
                        </td>
                        <td className="px-4 py-3.5 font-mono text-[11px] text-muted-foreground">
                          <span title={job.jobId}>{job.jobId.slice(0, 8)}…</span>
                        </td>
                        <td className="px-4 py-3.5 text-xs text-muted-foreground">
                          {job.printerId}
                        </td>
                        <td className="px-4 py-3.5">
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {job.payloadType}
                          </Badge>
                        </td>
                        <td className="px-4 py-3.5">
                          <StatusBadge status={job.status} />
                        </td>
                        <td className="px-4 py-3.5 text-xs">
                          {job.retryCount > 0 ? (
                            <span className="flex items-center gap-1 text-amber-400">
                              <XCircle className="h-3 w-3" />
                              {job.retryCount}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
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
