"use client";

import { useImperativeHandle, useLayoutEffect, useRef, type Ref, type TextareaHTMLAttributes } from "react";
import { cn } from "@/components/ui/cn";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  /** Grows with its text up to this many lines, then scrolls. */
  maxRows?: number;
  ref?: Ref<HTMLTextAreaElement>;
};

/** A textarea that grows with its content (1 line to `maxRows`). */
export function AutoTextarea({ value, onChange, maxRows = 3, className, ref, ...rest }: Props) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement, []);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
    el.style.height = "auto";
    const full = el.scrollHeight + borders;
    const max = line * maxRows + padding + borders;
    el.style.height = `${Math.ceil(Math.min(full, max))}px`;
    el.style.overflowY = full > max + 1 ? "auto" : "hidden";
  }, [value, maxRows]);

  return (
    <textarea
      ref={inner}
      rows={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn("block w-full resize-none", className)}
      {...rest}
    />
  );
}
