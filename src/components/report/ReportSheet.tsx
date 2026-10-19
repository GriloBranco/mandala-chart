"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useToday } from "@/client/useToday";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { ApiError } from "@/client/api";
import { actions, useAppState } from "@/client/store";
import { toast } from "@/client/toast";
import { newUuid } from "@/client/uuid";
import { defaultReportDay, quickSummary } from "./day";
import { ConfirmBar, ContextRow, FooterRow, ReportField } from "./parts";
import { announceReportSaved } from "./reports-data";

interface ReportSheetProps {
  open: boolean;
  /** null = a general report, not tied to one goal. */
  goalId: string | null;
  onClose: () => void;
}

/** The report sheet. Every opening is a fresh session, so closing always resets it. */
export function ReportSheet({ open, goalId, onClose }: ReportSheetProps) {
  if (!open) return null;
  return <ReportSession goalId={goalId} onClose={onClose} />;
}

function saveFailure(error: unknown): string {
  if (error instanceof ApiError && error.offline) return "You're offline. Keep this open and save again when you're back.";
  return error instanceof Error && error.message ? `Could not save. ${error.message}` : "Could not save. Try again.";
}

function ReportSession({ goalId, onClose }: Omit<ReportSheetProps, "open">) {
  const { goals } = useAppState();
  const today = useToday();
  const activeGoals = useMemo(() => goals.filter((goal) => goal.status === "active"), [goals]);

  // With a single goal, a general report is about that goal, so it also shows in that goal's reports.
  const [scope, setScope] = useState<string | null>(() => goalId ?? (activeGoals.length === 1 ? activeGoals[0].id : null));
  const [day, setDay] = useState(defaultReportDay);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  /** Set at once, unlike `saving`, so a second save in the same tick cannot get through. */
  const savingRef = useRef(false);
  /** Sent with each save, so a retry after a lost response cannot save the report twice. */
  const reportIdRef = useRef("");

  const scopeGoal = scope ? goals.find((goal) => goal.id === scope) : undefined;
  const target = scopeGoal ? scopeGoal.id : null;
  const scopeChoices = scopeGoal && scopeGoal.status !== "active" ? [scopeGoal, ...activeGoals] : activeGoals;

  const save = async () => {
    const value = text.trim();
    if (savingRef.current || !value) return;
    savingRef.current = true;
    reportIdRef.current ||= newUuid();
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await actions.saveReport({
        id: reportIdRef.current,
        goalId: target,
        day,
        text: value,
        summary: quickSummary(value),
      });
      announceReportSaved(saved);
      toast("Report saved");
      onClose();
    } catch (error) {
      savingRef.current = false;
      setSaving(false);
      setSaveError(saveFailure(error));
    }
  };

  // Esc, the X, the backdrop and a drag down all land here.
  const requestClose = () => {
    if (saving) return;
    if (confirm) setConfirm(false);
    else if (text.trim()) setConfirm(true);
    else onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The report field submits on its own Cmd/Ctrl+Enter; acting again here would send it twice.
    if (event.defaultPrevented || event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void save();
  };

  const footer = confirm ? (
    <ConfirmBar message="Discard this report?" onKeep={() => setConfirm(false)} onDiscard={onClose} />
  ) : (
    <FooterRow error={saveError}>
      <Button
        variant="primary"
        size="lg"
        className="flex-1 md:flex-none"
        loading={saving}
        disabled={!text.trim()}
        onClick={() => void save()}
      >
        Save report
      </Button>
    </FooterRow>
  );

  return (
    <Sheet open onClose={requestClose} title="Report" size="lg" footer={footer}>
      <div onKeyDown={onKeyDown}>
        <ContextRow
          goals={scopeChoices}
          scope={target}
          onScope={setScope}
          day={day}
          today={today}
          onDay={setDay}
          locked={saving}
        />
        <ReportField
          text={text}
          onText={(value) => {
            setText(value);
            setSaveError(null);
          }}
          onSubmit={() => void save()}
        />
      </div>
    </Sheet>
  );
}
