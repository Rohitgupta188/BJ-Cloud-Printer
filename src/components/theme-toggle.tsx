"use client";

import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

type Theme = "light" | "dark" | "system";

const THEMES: { value: Theme; label: string; icon: React.ElementType }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark",  label: "Dark",  icon: Moon },
  { value: "system",label: "System",icon: Monitor },
];

const emptySubscribe = () => () => {};

/**
 * ThemeToggle — a compact 3-segment pill that lets users switch between
 * Light, Dark, and System themes.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

  if (!mounted) {
    return (
      <div
        className={cn(
          "flex h-7 w-23 items-center rounded-lg border border-border/60 bg-muted/50 p-0.5",
          className
        )}
      />
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className={cn(
        "flex items-center rounded-lg border border-border/60 bg-muted/50 p-0.5 gap-0.5",
        className
      )}
    >
      {THEMES.map(({ value, label, icon: Icon }) => {
        const isActive = theme === value;
        return (
          <button
            key={value}
            role="radio"
            aria-checked={isActive}
            aria-label={`${label} theme`}
            id={`theme-toggle-${value}`}
            onClick={() => setTheme(value)}
            className={cn(
              "relative flex items-center justify-center rounded-md p-1.5 text-xs font-medium transition-all duration-200",
              "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-1",
              isActive
                ? "bg-background text-foreground shadow-sm ring-1 ring-border/50"
                : "text-muted-foreground hover:text-foreground"
            )}
            title={label}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
