"use client";

import { Archive, Ellipsis, NotebookPen, Pencil, RotateCcw, Trash2, Trophy, Zap } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ApiError } from "@/client/api";
import { navigate } from "@/client/nav";
import { actions } from "@/client/store";
import { toast } from "@/client/toast";
import type { GoalStatus, GoalWithCells } from "@/domain/types";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Sheet } from "@/components/ui/Sheet";

interface MenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  run: () => void;
  tone?: "danger";
}

const STATUS_TOAST: Record<GoalStatus, string> = {
  achieved: "Goal achieved. Well done.",
  archived: "Goal archived",
  active: "Goal is active again",
};

export function setGoalStatus(goal: GoalWithCells, status: GoalStatus) {
  const before = goal.status;
  if (before === status) return;
  actions.updateGoal(goal.id, { status });
  toast(STATUS_TOAST[status], {
    action: { label: "Undo", run: () => actions.updateGoal(goal.id, { status: before }) },
  });
}

async function deleteGoal(goal: GoalWithCells) {
  // Leave first, so the chart never flashes "this goal is gone".
  navigate({ name: "today" }, { replace: true });
  try {
    await actions.deleteGoal(goal.id);
    toast("Goal deleted");
  } catch (error) {
    toast(
      error instanceof ApiError && error.offline
        ? "You're offline, so the goal was not deleted."
        : "Could not delete the goal. Try again.",
      { tone: "error" },
    );
  }
}

/**
 * The goal's "More" menu: edit, reports, status, delete (with a confirm step).
 * A small popover on desktop, a bottom sheet on phones.
 */
export function GoalMenu({
  goal,
  isDesktop,
  onEditGoal,
}: {
  goal: GoalWithCells;
  isDesktop: boolean;
  onEditGoal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const close = () => {
    setOpen(false);
    setConfirming(false);
  };
  const pick = (run: () => void) => () => {
    close();
    run();
  };

  const items: MenuItem[] = [{ key: "edit", label: "Edit goal", icon: <Pencil size={17} />, run: pick(onEditGoal) }];
  if (!isDesktop) {
    items.push({
      key: "lever",
      label: "Leverage",
      icon: <Zap size={17} />,
      run: pick(() => navigate({ name: "lever", goalId: goal.id })),
    });
  }
  items.push({
    key: "reports",
    label: "Reports for this goal",
    icon: <NotebookPen size={17} />,
    run: pick(() => navigate({ name: "reports", goalId: goal.id })),
  });
  if (goal.status !== "active") {
    items.push({
      key: "active",
      label: "Make active again",
      icon: <RotateCcw size={17} />,
      run: pick(() => setGoalStatus(goal, "active")),
    });
  }
  if (goal.status !== "achieved") {
    items.push({
      key: "achieved",
      label: "Mark achieved",
      icon: <Trophy size={17} />,
      run: pick(() => setGoalStatus(goal, "achieved")),
    });
  }
  if (goal.status !== "archived") {
    items.push({
      key: "archived",
      label: "Archive",
      icon: <Archive size={17} />,
      run: pick(() => setGoalStatus(goal, "archived")),
    });
  }
  items.push({
    key: "delete",
    label: "Delete goal",
    icon: <Trash2 size={17} />,
    tone: "danger",
    run: () => setConfirming(true),
  });

  const confirm = (
    <DeleteConfirm
      onCancel={() => setConfirming(false)}
      onDelete={() => {
        close();
        void deleteGoal(goal);
      }}
    />
  );

  if (isDesktop) {
    return (
      <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        {confirming ? confirm : items.map((item) => <PopoverItem key={item.key} item={item} />)}
      </Popover>
    );
  }

  return (
    <>
      <IconButton label="More" size="lg" onClick={() => setOpen(true)}>
        <Ellipsis size={20} />
      </IconButton>
      <Sheet open={open} onClose={close} title={confirming ? "Delete goal" : "Goal"} size="sm">
        {confirming ? (
          confirm
        ) : (
          <div className="-mx-2 pb-1" role="menu" aria-label="Goal actions">
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                onClick={item.run}
                className={cn(
                  "flex h-12 w-full items-center gap-3.5 rounded-xl px-3 text-left text-[15px] transition-colors hover:bg-soft active:bg-soft",
                  item.tone === "danger" ? "text-danger" : "text-fg",
                )}
              >
                <span className={cn("shrink-0", item.tone === "danger" ? "text-danger" : "text-muted")}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </Sheet>
    </>
  );
}

function DeleteConfirm({ onCancel, onDelete }: { onCancel: () => void; onDelete: () => void }) {
  return (
    <div className="p-2">
      <p className="text-[15px] font-medium">Delete this goal?</p>
      <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
        Its 72 squares, check-ins and reports go with it. This can&apos;t be undone.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} autoFocus>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<Trash2 size={14} />}
          onClick={onDelete}
          className="bg-danger! hover:bg-danger/90!"
        >
          Delete goal
        </Button>
      </div>
    </div>
  );
}

// ---------- desktop popover ----------

function Popover({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const requestClose = useEffectEvent((refocus: boolean) => {
    onOpenChange(false);
    if (refocus) wrapRef.current?.querySelector<HTMLElement>("button")?.focus();
  });

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) requestClose(false);
    };
    // Capture: Esc closes the menu before the chart sees it (where it would clear the selection).
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      requestClose(true);
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("button")?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
    if (!buttons.length) return;
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return (
    <div ref={wrapRef} className="relative">
      <IconButton
        label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={cn(open && "bg-soft")}
      >
        <Ellipsis size={20} />
      </IconButton>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Goal actions"
          onKeyDown={onMenuKey}
          className="absolute top-full right-0 z-40 mt-2 w-64 animate-rise rounded-2xl border border-line bg-bg p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.10)]"
        >
          {children}
        </div>
      )}
    </div>
  );
}

function PopoverItem({ item }: { item: MenuItem }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={item.run}
      className={cn(
        "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-soft focus-visible:bg-soft focus-visible:outline-none!",
        item.tone === "danger" ? "text-danger" : "text-fg",
      )}
    >
      <span className={cn("shrink-0", item.tone === "danger" ? "text-danger" : "text-muted")}>{item.icon}</span>
      {item.label}
    </button>
  );
}
