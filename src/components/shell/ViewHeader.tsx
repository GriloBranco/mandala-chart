"use client";

import { Menu } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { useShell } from "./ShellContext";

/**
 * Sticky top bar every view uses. On phones it shows the menu button (goals drawer)
 * unless the view passes its own `left` control, such as Back.
 */
export function ViewHeader({
  title,
  subtitle,
  left,
  right,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  const { openDrawer, isDesktop } = useShell();
  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-line bg-bg/90 px-3 pt-[var(--safe-top)] backdrop-blur-md lg:min-h-16 lg:px-6",
        className,
      )}
    >
      {left ??
        (!isDesktop && (
          <IconButton label="Goals" onClick={openDrawer}>
            <Menu size={20} />
          </IconButton>
        ))}
      <div className="min-w-0 flex-1 py-2">
        {title !== undefined && <div className="truncate text-[15px] font-semibold tracking-tight lg:text-base">{title}</div>}
        {subtitle !== undefined && <div className="truncate text-xs text-muted">{subtitle}</div>}
      </div>
      {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
    </header>
  );
}
