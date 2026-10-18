"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState, type InputHTMLAttributes, type Ref, type SyntheticEvent } from "react";
import { IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { ApiError } from "@/client/api";

export type FieldShape = "pill" | "box";

const SHAPES: Record<FieldShape, string> = {
  // The sign-in page: 16px everywhere, so iPhone never zooms in.
  pill: "rounded-full px-5 text-[16px]",
  // Inside the app, like its other forms (globals.css makes it 16px on touch screens).
  box: "rounded-xl px-4 text-[15px]",
};

/** A one-line text field, 48px tall. */
export function fieldClass(shape: FieldShape): string {
  return cn(
    "h-12 w-full border border-line-strong bg-bg text-fg outline-none! transition-colors placeholder:text-faint focus:border-fg",
    SHAPES[shape],
  );
}

/** The server's own message, or a plain one when the request never reached it. */
export function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.offline ? "You're offline. Check your connection and try again." : error.message;
}

/** Stops a tap from taking focus out of the field, so the phone keyboard stays up. */
function keepFocus(event: SyntheticEvent) {
  event.preventDefault();
}

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "className"> & {
  value: string;
  onChange: (value: string) => void;
  /** The accessible name: the field shows a placeholder, not a visible label. */
  label: string;
  shape?: FieldShape;
  /** For the wrapper, such as a margin. */
  className?: string;
  ref?: Ref<HTMLInputElement>;
};

/** A password field with a show / hide button inside it. */
export function PasswordInput({ value, onChange, label, shape = "box", className, ref, ...rest }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={cn("relative", className)}>
      <input
        ref={ref}
        {...rest}
        type={visible ? "text" : "password"}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // Shown as text, a password must not be capitalized or corrected.
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn(fieldClass(shape), "pr-14")}
      />
      <IconButton
        label={visible ? "Hide password" : "Show password"}
        size="lg"
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={() => setVisible((shown) => !shown)}
        className="absolute top-0.5 right-0.5 text-muted hover:text-fg"
      >
        {visible ? <EyeOff size={18} /> : <Eye size={18} />}
      </IconButton>
    </div>
  );
}
