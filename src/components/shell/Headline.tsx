"use client";

import { Pencil } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AutoTextarea } from "@/components/goal/AutoTextarea";
import { cn } from "@/components/ui/cn";
import { ApiError } from "@/lib/api-client";
import { actions, getState, useAppState } from "@/lib/store";
import { toast } from "@/lib/toast";

/** The default line, shown until the person writes their own. */
export const HEADLINE = "I just need to be the best version of myself compared to the other versions";

/** The longest line the server keeps. */
export const HEADLINE_MAX = 160;

/** One trimmed line. Empty means the default line, and so does the default itself. */
export function cleanHeadline(value: string): string {
  const line = value.replace(/\s+/g, " ").trim().slice(0, HEADLINE_MAX);
  return line === HEADLINE ? "" : line;
}

/** Saves the person's line. It shows at once and goes back if the server says no. */
export async function saveHeadline(value: string): Promise<boolean> {
  const user = getState().user;
  // Not loaded yet: there is no account to save it to.
  if (!user) return false;
  const next = cleanHeadline(value);
  if (next === user.headline) return true;
  try {
    await actions.updateHeadline(next);
    return true;
  } catch (error) {
    const offline = error instanceof ApiError && error.offline;
    toast(offline ? "You're offline, so your line was not saved." : "Could not save your line.", {
      tone: "error",
      action: { label: "Try again", run: () => void saveHeadline(next) },
    });
    return false;
  }
}

/** Covers the longest entrance: 160 characters is at most about 80 words. */
const ENTRANCE_MS = 4000;

const TYPE = "font-semibold tracking-[-0.025em] text-fg [overflow-wrap:anywhere]";

// Words rise in one by one on the first view after the app opens; later visits show it still.
let playedThisLoad = false;

export function Headline({ className, editable = false }: { className?: string; editable?: boolean }) {
  const { user } = useAppState();
  const text = user?.headline || HEADLINE;
  const [entrance, setEntrance] = useState(() => !playedThisLoad);
  const [editing, setEditing] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    playedThisLoad = true;
    if (!entrance) return;
    // Once it has played, a new line (saved here or on another device) just appears.
    const timer = setTimeout(() => setEntrance(false), ENTRANCE_MS);
    return () => clearTimeout(timer);
  }, [entrance]);

  if (editing) {
    return (
      <HeadlineEditor
        initial={text}
        className={className}
        onClose={(refocus) => {
          setEditing(false);
          // Keyboard users land back on the line. On phones the keyboard just goes away.
          if (refocus && window.matchMedia("(hover: hover)").matches) {
            requestAnimationFrame(() => button.current?.focus());
          }
        }}
      />
    );
  }

  const words = text.split(" ").filter(Boolean);
  const content = words.map((word, i) => (
    <span key={i} aria-hidden>
      {i > 0 && " "}
      <span
        className={cn("inline-block", entrance && "animate-rise")}
        style={entrance ? { animationDelay: `${150 + i * 45}ms` } : undefined}
      >
        {word}
        {editable && i === words.length - 1 && (
          <Pencil
            aria-hidden
            strokeWidth={2.25}
            className="ml-[0.3em] inline-block size-[0.5em] align-baseline text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        )}
      </span>
    </span>
  ));

  if (!editable) {
    return (
      <h1 aria-label={text} className={cn("text-balance", TYPE, className)}>
        {content}
      </h1>
    );
  }

  return (
    // Same box as the editor, so the focus ring sits where the text box will open. flow-root
    // keeps the button's negative margins from moving the line.
    <h1 className={cn("flow-root text-balance", TYPE, className)}>
      <button
        ref={button}
        type="button"
        aria-label={text}
        title="Edit your line"
        onClick={() => {
          setEntrance(false);
          setEditing(true);
        }}
        className="group -mx-2.5 -my-1.5 block w-[calc(100%+1.25rem)] cursor-text rounded-xl px-2.5 py-1.5 [text-align:inherit]"
      >
        {content}
      </button>
    </h1>
  );
}

/** The line in place, as a text box of the same size. Enter saves, Esc cancels. */
function HeadlineEditor({
  initial,
  className,
  onClose,
}: {
  initial: string;
  className?: string;
  onClose: (refocus: boolean) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  const closed = useRef(false);

  useEffect(() => {
    // The whole line starts selected: typing replaces it, a tap places the cursor.
    field.current?.select();
  }, []);

  const close = (save: boolean, refocus: boolean) => {
    // Removing the box can fire one more blur; the first close wins.
    if (closed.current) return;
    closed.current = true;
    onClose(refocus);
    // No change saves nothing; empty goes back to the default line.
    if (save) void saveHeadline(draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while composing (Japanese, Chinese) picks the characters; it does not save.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      close(true, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(false, true);
    }
  };

  const nearLimit = draft.length >= HEADLINE_MAX - 20;

  return (
    // flow-root keeps the box's negative margins inside, so the text stays exactly in place.
    <div className={cn("relative flow-root", TYPE, className)}>
      <div className="-mx-2.5 -my-1.5 rounded-xl bg-soft px-2.5 py-1.5">
        <AutoTextarea
          ref={field}
          value={draft}
          // One line only: a pasted line break becomes a space.
          onChange={(value) => setDraft(value.replace(/\s*\n\s*/g, " "))}
          onKeyDown={onKeyDown}
          onBlur={() => close(true, false)}
          autoFocus
          maxRows={8}
          maxLength={HEADLINE_MAX}
          enterKeyHint="done"
          aria-label="Your line"
          placeholder={HEADLINE}
          // Same size as the line itself; globals.css would force 16px on touch screens.
          className="bg-transparent outline-none! [font-size:inherit]! placeholder:text-faint"
        />
      </div>
      {/* Wide screens have room for it below the line. Phones only show the count near the limit. */}
      <div
        className={cn(
          "mt-3 flex justify-between gap-3 font-mono text-[11px] leading-none font-normal tracking-normal text-faint lg:pointer-events-none lg:absolute lg:inset-x-0 lg:top-full",
          !nearLimit && "max-lg:hidden",
        )}
      >
        <span className="hidden lg:pointer-fine:inline">Enter to save · Esc to cancel</span>
        <span className="ml-auto">
          {draft.length}/{HEADLINE_MAX}
        </span>
      </div>
    </div>
  );
}
