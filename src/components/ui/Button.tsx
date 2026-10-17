"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AsciiSpinner } from "@/components/ascii/AsciiSpinner";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-fg text-white hover:bg-black/80",
  secondary: "bg-bg text-fg border border-line-strong hover:bg-soft",
  ghost: "text-fg hover:bg-soft",
  danger: "text-danger hover:bg-red-50",
  accent: "bg-accent text-white hover:brightness-95",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-[15px] gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium whitespace-nowrap",
        "transition-[background-color,transform,opacity] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <AsciiSpinner size="sm" /> : icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "sm" | "md" | "lg";
  variant?: "ghost" | "secondary" | "primary" | "accent";
}

const ICON_SIZES = { sm: "size-8", md: "size-10", lg: "size-11" };

/** Round icon-only button. `label` is required: it is the accessible name. */
export function IconButton({
  label,
  size = "md",
  variant = "ghost",
  className,
  children,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full transition-[background-color,transform] duration-150 active:scale-95 disabled:opacity-40",
        variant === "ghost" && "text-fg hover:bg-soft",
        variant === "secondary" && "border border-line-strong bg-bg text-fg hover:bg-soft",
        variant === "primary" && "bg-fg text-white hover:bg-black/80",
        variant === "accent" && "bg-accent text-white",
        ICON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
