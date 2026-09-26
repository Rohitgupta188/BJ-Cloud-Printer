"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/theme-toggle";
import { Printer, LayoutDashboard, Plus, LogOut } from "lucide-react";
import { csrfHeaders } from "@/lib/security/csrf-client";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/print", label: "New Print Job", icon: Plus },
] as const;

function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: csrfHeaders(),
      });
    } catch {
      // Always clear client state regardless of network error.
    }
    toast.success("Signed out successfully.");
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-border/50 bg-sidebar z-30 select-none">
      {/* Top Header: Brand + Theme & Sign out */}
      <div className="p-4 pb-3 space-y-3">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/15 shadow-xs">
            <Printer className="h-4.5 w-4.5 text-primary" />
          </div>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-bold tracking-tight">BJ Printer</p>
            <p className="text-[10px] text-muted-foreground font-medium">Cloud System</p>
          </div>
        </div>

        {/* Top Actions: Theme toggle & Sign out */}
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/40">
          <ThemeToggle />
          <Button
            id="sidebar-logout-btn"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs font-medium gap-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded-md transition-colors"
            onClick={handleLogout}
            title="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </Button>
        </div>
      </div>

      <Separator className="opacity-40" />

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4 overflow-y-auto">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150",
                isActive
                  ? "border border-primary/20 bg-primary/10 text-primary font-semibold shadow-xs"
                  : "text-sidebar-foreground hover:bg-accent/70 hover:text-accent-foreground"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      <Separator className="opacity-40" />

      {/* Station Status at bottom */}
      <div className="p-3">
        <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-muted/30 border border-border/30 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-medium text-foreground/80">Station Ready</span>
          </div>
          <span className="font-mono text-[10px] text-muted-foreground/70 uppercase">
            mumbai-01
          </span>
        </div>
      </div>
    </aside>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
