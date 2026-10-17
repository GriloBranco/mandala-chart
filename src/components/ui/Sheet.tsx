"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";
import { useKeyboardInset, useMediaQuery, useVisualViewportHeight } from "./hooks";
import { IconButton } from "./Button";

/**
 * Bottom sheet on phones (drag down to close, stays above the keyboard),
 * centered dialog on wider screens. Esc and the backdrop close it.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const wide = useMediaQuery("(min-width: 768px)");
  const inset = useKeyboardInset();
  const viewportHeight = useVisualViewportHeight();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus the dialog unless something inside asked for focus (autoFocus).
    const frame = requestAnimationFrame(() => {
      if (panel.current && !panel.current.contains(document.activeElement)) panel.current.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const onPointerDown = (event: React.PointerEvent) => {
    if (wide) return;
    dragStart.current = event.clientY;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (dragStart.current === null) return;
    setDrag(Math.max(0, event.clientY - dragStart.current));
  };
  const onPointerUp = () => {
    if (dragStart.current === null) return;
    dragStart.current = null;
    if (drag > 90) onClose();
    setDrag(0);
  };

  const widths = { sm: "md:max-w-sm", md: "md:max-w-lg", lg: "md:max-w-2xl" };

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 animate-fade-in bg-black/25" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cn(
          "absolute flex flex-col bg-bg outline-none",
          wide
            ? "top-1/2 left-1/2 max-h-[85dvh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 animate-zoom rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.12)]"
            : "inset-x-0 max-h-[92dvh] animate-sheet rounded-t-2xl pb-[var(--safe-bottom)] shadow-[0_-8px_30px_rgba(0,0,0,0.08)]",
          widths[size],
          className,
        )}
        style={
          wide
            ? undefined
            : {
                bottom: inset,
                // With the keyboard up, keep the title and first field on screen above it.
                maxHeight: inset && viewportHeight ? viewportHeight - 8 : undefined,
                transform: drag ? `translateY(${drag}px)` : undefined,
              }
        }
      >
        <div
          className={cn("shrink-0 touch-none", wide ? "px-6 pt-5" : "px-5 pt-2")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {!wide && <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-line-strong" aria-hidden />}
          {title !== undefined && (
            <div className="flex min-h-10 items-center justify-between gap-3">
              <h2 id={titleId} className="text-[15px] font-semibold tracking-tight">
                {title}
              </h2>
              <IconButton label="Close" size="sm" onClick={onClose} className="-mr-1 text-muted">
                <X size={18} />
              </IconButton>
            </div>
          )}
        </div>
        <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", wide ? "px-6 pb-6" : "px-5 pb-5")}>
          {children}
        </div>
        {footer && (
          <div className={cn("shrink-0 border-t border-line", wide ? "px-6 py-4" : "px-5 py-3")}>{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
