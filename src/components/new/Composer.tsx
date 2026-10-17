"use client";

import { CornerDownLeft, X } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { IconButton } from "@/components/ui/Button";
import { keepFocus } from "./StepParts";

/**
 * The one input that fills the chart. It always edits the selected square: type, press
 * Enter, and the next empty square is selected. Enter on an empty line moves on.
 */
export function Composer({
  inputRef,
  value,
  label,
  placeholder,
  enterKeyHint,
  enterLabel,
  hint,
  extra,
  autoFocus,
  onChange,
  onEnter,
  onClear,
  onFocus,
  onBlur,
  onSubmit,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  label: string;
  placeholder: string;
  enterKeyHint: "next" | "done";
  /** Accessible name of the round Enter button. */
  enterLabel: string;
  hint?: ReactNode;
  /** Right of the hint, e.g. the Task | Habit toggle. */
  extra?: ReactNode;
  autoFocus?: boolean;
  onChange: (text: string) => void;
  onEnter: (text: string) => void;
  onClear?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Cmd/Ctrl+Enter: go to the next step. */
  onSubmit?: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.currentTarget.blur();
      return;
    }
    // keyCode 229: Safari still composing (IME or autocorrect), not a real Enter.
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if ((event.metaKey || event.ctrlKey) && onSubmit) onSubmit();
    else onEnter(event.currentTarget.value);
  };

  return (
    <div>
      <div className="flex h-12 items-center gap-1 rounded-full border border-line-strong bg-bg pr-1 pl-4 transition-colors focus-within:border-fg">
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          aria-label={label}
          placeholder={placeholder}
          enterKeyHint={enterKeyHint}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="sentences"
          maxLength={200}
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none! placeholder:text-faint"
        />
        {value && onClear && (
          <IconButton label="Clear square" size="sm" className="text-muted" onPointerDown={keepFocus} onClick={onClear}>
            <X size={16} />
          </IconButton>
        )}
        <IconButton
          label={enterLabel}
          variant={value.trim() ? "primary" : "ghost"}
          onPointerDown={keepFocus}
          onClick={() => onEnter(inputRef.current?.value ?? value)}
        >
          <CornerDownLeft size={17} />
        </IconButton>
      </div>
      {(hint || extra) && (
        <div className="mt-1.5 flex min-h-8 items-center gap-2 pr-1 pl-4">
          <div className="min-w-0 flex-1 text-[12.5px] leading-snug text-muted" aria-live="polite">
            {hint}
          </div>
          {extra}
        </div>
      )}
    </div>
  );
}
