"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useToday } from "@/client/useToday";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { ai } from "@/client/ai";
import { ApiError } from "@/client/api";
import { actions, getState, useAppState } from "@/client/store";
import { toast } from "@/client/toast";
import type { ProposedUpdate, ReportAnalysis, ReportSource } from "@/domain/types";
import { newUuid } from "@/client/uuid";
import { plural } from "./format";
import {
  AudioNote,
  ConfirmBar,
  ContextRow,
  FailedPanel,
  FooterRow,
  ProcessingPanel,
  ReviewPanel,
  TypedPanel,
  VoicePanel,
} from "./RecorderPanels";
import { announceReportSaved } from "./reports-data";
import {
  analyzeFailure,
  defaultReportDay,
  indexCells,
  quickSummary,
  reviewItems,
  voiceOffReason,
  type ReviewItem,
} from "./review";
import { useVoiceRecorder, voiceSupport, type MicProblem } from "./useVoiceRecorder";

type Step =
  | { kind: "compose" }
  | { kind: "processing"; source: ReportSource }
  | { kind: "failed"; source: ReportSource; message: string; retry: boolean }
  | { kind: "review"; source: ReportSource };

interface RecorderProps {
  open: boolean;
  /** null = a general report, mapped across all active goals. */
  goalId: string | null;
  /** Start in text mode. */
  typed: boolean;
  onClose: () => void;
}

/** The report sheet. Every opening is a fresh session, so closing always resets it and releases the mic. */
export function Recorder({ open, goalId, typed, onClose }: RecorderProps) {
  if (!open) return null;
  return <RecorderSession goalId={goalId} typed={typed} onClose={onClose} />;
}

function saveFailure(error: unknown): string {
  if (error instanceof ApiError && error.offline) return "You're offline. Keep this open and save again when you're back.";
  return error instanceof Error && error.message ? `Could not save. ${error.message}` : "Could not save. Try again.";
}

function RecorderSession({ goalId, typed, onClose }: Omit<RecorderProps, "open">) {
  const { status, goals, aiEnabled } = useAppState();
  const today = useToday();
  const activeGoals = useMemo(() => goals.filter((goal) => goal.status === "active"), [goals]);
  const cells = useMemo(() => indexCells(goals), [goals]);

  // Until the store has loaded (a cold start from the home-screen shortcut), assume AI is on;
  // the server still says so clearly if it is not.
  const aiOn = aiEnabled || status !== "ready";
  const [support] = useState(voiceSupport);
  const offReason = voiceOffReason(aiOn, support);
  const [chosenMode, setChosenMode] = useState<"voice" | "text" | null>(typed ? "text" : null);
  const mode = chosenMode ?? (offReason ? "text" : "voice");

  // With a single goal, a general report is about that goal, so it also shows in that goal's reports.
  const [scope, setScope] = useState<string | null>(() => goalId ?? (activeGoals.length === 1 ? activeGoals[0].id : null));
  const [day, setDay] = useState(defaultReportDay);
  const [step, setStep] = useState<Step>({ kind: "compose" });
  const [text, setText] = useState("");
  const [audio, setAudio] = useState<Blob | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<MicProblem | null>(null);
  const [summary, setSummary] = useState("");
  const [transcript, setTranscript] = useState("");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"close" | "recording" | null>(null);
  /** Bumped to ignore an analysis that is still on its way (closed, switched to typing). */
  const runRef = useRef(0);
  /** A failed save already showed its changes in the chart. */
  const shownChangesRef = useRef(false);
  /** Set at once, unlike `saving`, so a second save in the same tick cannot get through. */
  const savingRef = useRef(false);
  /** Sent with each save, so a retry after a lost response cannot save the report twice. */
  const reportIdRef = useRef("");

  useEffect(() => {
    return () => {
      runRef.current += 1;
    };
  }, []);

  const scopeGoal = scope ? goals.find((goal) => goal.id === scope) : undefined;
  const target = scopeGoal ? scopeGoal.id : null;
  const scopeChoices = scopeGoal && scopeGoal.status !== "active" ? [scopeGoal, ...activeGoals] : activeGoals;

  // ---------- analysis ----------

  const openReview = (source: ReportSource, analysis: ReportAnalysis, typedText: string) => {
    const said = (source === "text" ? typedText : (analysis.transcript ?? "")).trim();
    if (!said) {
      setStep({ kind: "failed", source, message: "Couldn't hear anything in that recording.", retry: false });
      return;
    }
    const current = getState();
    // The save endpoint caps these lengths; maxLength on the fields only limits typing.
    setTranscript(said.slice(0, 20000));
    setSummary((analysis.summary ?? "").trim().slice(0, 1000));
    setItems(reviewItems(analysis.updates ?? [], indexCells(current.goals), current.checkins, day));
    setStep({ kind: "review", source });
  };

  const runAnalysis = (source: ReportSource, request: () => Promise<ReportAnalysis>, typedText = "") => {
    const run = ++runRef.current;
    reportIdRef.current = ""; // a new analysis is a new report
    setConfirm(null);
    setSaveError(null);
    setStep({ kind: "processing", source });
    const send = () => {
      request().then(
        (analysis) => {
          if (run === runRef.current) openReview(source, analysis, typedText);
        },
        (error: unknown) => {
          if (run === runRef.current) setStep({ kind: "failed", source, ...analyzeFailure(error, source) });
        },
      );
    };
    if (document.visibilityState !== "hidden") {
      send();
      return;
    }
    // Stopped because the app went to the background: send once it is back in front.
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", onVisible);
      if (run === runRef.current) send();
    };
    document.addEventListener("visibilitychange", onVisible);
  };

  const voice = useVoiceRecorder({
    onRecorded: ({ blob }) => {
      setAudio(blob);
      runAnalysis("voice", () => ai.analyzeAudio({ audio: blob, goalId: target, day }));
    },
    onTooShort: () => setNotice("Too short. Tap, talk, then tap again to finish."),
    onProblem: setProblem,
  });

  const analyzeTyped = () => {
    const value = text.trim();
    if (!value) return;
    runAnalysis("text", () => ai.analyzeText({ text: value, goalId: target, day }), value);
  };

  // ---------- mode switches ----------

  const startRecording = () => {
    setNotice(null);
    setProblem(null);
    setChosenMode("voice");
    voice.start();
  };

  const cancelRecording = () => {
    if (voice.phase === "recording" && voice.seconds >= 5) setConfirm("recording");
    else voice.cancel();
  };

  const discardRecording = () => {
    voice.cancel();
    setConfirm(null);
  };

  const typeInstead = () => {
    voice.cancel();
    runRef.current += 1;
    setChosenMode("text");
    setAudio(null);
    setProblem(null);
    setNotice(null);
    setConfirm(null);
    setStep({ kind: "compose" });
  };

  const switchToVoice = () => {
    setChosenMode("voice");
    setStep({ kind: "compose" });
  };

  const recordAgain = () => {
    runRef.current += 1;
    setAudio(null);
    setChosenMode("voice");
    setStep({ kind: "compose" });
  };

  const retry = () => {
    if (step.kind !== "failed") return;
    if (step.source === "text") analyzeTyped();
    else if (audio) runAnalysis("voice", () => ai.analyzeAudio({ audio, goalId: target, day }));
    else recordAgain();
  };

  // ---------- saving ----------

  const persist = async (
    source: ReportSource,
    report: { transcript: string; summary: string; updates: ProposedUpdate[] },
  ) => {
    if (savingRef.current || !report.transcript) return;
    savingRef.current = true;
    reportIdRef.current ||= newUuid();
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await actions.saveReport({ id: reportIdRef.current, goalId: target, source, day, ...report });
      announceReportSaved(saved);
      const count = report.updates.length;
      toast(count ? `Report saved · ${plural(count, "update")}` : "Report saved");
      onClose();
    } catch (error) {
      if (report.updates.length) shownChangesRef.current = true;
      savingRef.current = false;
      setSaving(false);
      setSaveError(saveFailure(error));
    }
  };

  const selectedCount = items.filter((item) => item.checked).length;

  const saveReview = () => {
    if (step.kind !== "review") return;
    void persist(step.source, {
      transcript: transcript.trim(),
      summary: summary.trim(),
      updates: items.filter((item) => item.checked).map((item) => item.update),
    });
  };

  const saveTyped = () => {
    const value = text.trim();
    if (value) void persist("text", { transcript: value, summary: quickSummary(value), updates: [] });
  };

  // ---------- closing ----------

  const dirty =
    voice.phase !== "idle" ||
    step.kind === "processing" ||
    step.kind === "review" ||
    audio !== null ||
    text.trim() !== "";
  const confirmKind = confirm === "recording" && voice.phase !== "recording" ? null : confirm;

  const discard = () => {
    voice.cancel();
    runRef.current += 1;
    // The chart may be showing changes from a save that failed: reload to drop them.
    if (shownChangesRef.current) void actions.refresh();
    onClose();
  };

  // Esc, the X, the backdrop and a drag down all land here.
  const requestClose = () => {
    if (saving) return;
    if (confirmKind) setConfirm(null);
    else if (dirty) setConfirm("close");
    else discard();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The report field submits on its own Cmd/Ctrl+Enter; acting again here would send it twice.
    if (event.defaultPrevented || event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    if (step.kind === "review") {
      event.preventDefault();
      saveReview();
    } else if (step.kind === "compose" && mode === "text") {
      event.preventDefault();
      if (aiOn) analyzeTyped();
      else saveTyped();
    }
  };

  // ---------- layout ----------

  let body: ReactNode;
  if (step.kind === "processing") {
    body = <ProcessingPanel source={step.source} />;
  } else if (step.kind === "failed") {
    body = (
      <FailedPanel
        source={step.source}
        message={step.message}
        retry={step.retry}
        saving={saving}
        saveError={saveError}
        onRetry={retry}
        onRecordAgain={recordAgain}
        onType={typeInstead}
        onEdit={() => setStep({ kind: "compose" })}
        onSaveAsIs={saveTyped}
      />
    );
  } else if (step.kind === "review") {
    body = (
      <ReviewPanel
        summary={summary}
        onSummary={setSummary}
        transcript={transcript}
        onTranscript={setTranscript}
        items={items}
        onToggle={(index) =>
          setItems((list) => list.map((item, i) => (i === index ? { ...item, checked: !item.checked } : item)))
        }
        cells={cells}
        showGoal={target === null && activeGoals.length > 1}
        day={day}
        today={today}
      />
    );
  } else if (mode === "voice") {
    body = (
      <VoicePanel
        phase={voice.phase}
        seconds={voice.seconds}
        analyser={voice.analyser}
        problem={problem}
        notice={notice}
        onStart={startRecording}
        onStop={voice.stop}
        onCancel={voice.phase === "starting" ? voice.cancel : cancelRecording}
        onType={typeInstead}
      />
    );
  } else {
    body = (
      <TypedPanel
        text={text}
        onText={(value) => {
          setText(value);
          setSaveError(null);
        }}
        onSubmit={aiOn ? analyzeTyped : saveTyped}
        reason={offReason}
        onVoice={offReason ? undefined : switchToVoice}
      />
    );
  }

  let footer: ReactNode = null;
  if (confirmKind) {
    footer = (
      <ConfirmBar
        message={confirmKind === "recording" ? "Discard this recording?" : "Discard this report?"}
        onKeep={() => setConfirm(null)}
        onDiscard={confirmKind === "recording" ? discardRecording : discard}
      />
    );
  } else if (step.kind === "review") {
    footer = (
      <FooterRow error={saveError}>
        <Button variant="ghost" size="lg" disabled={saving} onClick={() => setConfirm("close")}>
          Discard
        </Button>
        <Button
          variant="primary"
          size="lg"
          className="flex-1 md:flex-none"
          loading={saving}
          disabled={!transcript.trim()}
          onClick={saveReview}
        >
          {selectedCount ? `Save report · ${plural(selectedCount, "update")}` : "Save report"}
        </Button>
      </FooterRow>
    );
  } else if (step.kind === "compose" && mode === "text") {
    const empty = !text.trim();
    footer = aiOn ? (
      <FooterRow error={saveError}>
        <Button variant="ghost" size="lg" loading={saving} disabled={empty} onClick={saveTyped}>
          Just save
        </Button>
        <Button
          variant="primary"
          size="lg"
          className="flex-1 md:flex-none md:min-w-36"
          disabled={empty || saving}
          onClick={analyzeTyped}
        >
          Analyze
        </Button>
      </FooterRow>
    ) : (
      <FooterRow error={saveError}>
        <Button variant="primary" size="lg" className="flex-1 md:flex-none" loading={saving} disabled={empty} onClick={saveTyped}>
          Save report
        </Button>
      </FooterRow>
    );
  }

  const showAudioNote =
    mode === "voice" && (step.kind === "compose" || (step.kind === "processing" && step.source === "voice"));

  return (
    <Sheet open onClose={requestClose} title={step.kind === "review" ? "Review" : "Report"} size="lg" footer={footer}>
      <div onKeyDown={onKeyDown}>
        <ContextRow
          goals={scopeChoices}
          scope={target}
          onScope={setScope}
          day={day}
          today={today}
          onDay={setDay}
          locked={step.kind !== "compose" || saving}
        />
        {body}
        {showAudioNote && <AudioNote />}
      </div>
    </Sheet>
  );
}
