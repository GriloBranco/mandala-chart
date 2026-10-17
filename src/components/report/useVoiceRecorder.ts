"use client";

import { useEffect, useRef, useState } from "react";

// Voice capture for reports. All media work happens here so the sheet only sees
// "idle | starting | recording", a seconds counter, the meter's analyser and the result.
//
// iOS rules this follows: the mic and the AudioContext are both started inside the tap
// (nothing async before them), Safari records audio/mp4 while Chrome records webm, and
// leaving the app or locking the phone ends capture, so we finish with what was said.

export type MicProblem = "denied" | "missing" | "busy" | "insecure" | "unsupported" | "failed";
export type VoicePhase = "idle" | "starting" | "recording";

export interface Recording {
  blob: Blob;
  durationMs: number;
}

/** Reports stop at 5 minutes: plenty to talk, and the upload stays far below the server's 4 MB limit. */
export const MAX_RECORDING_MS = 5 * 60 * 1000;
const MIN_RECORDING_MS = 1000;
const MIN_BYTES = 1024;
/** Safety net for a browser that ignores the bitrate: stop before the server's 4 MB limit. */
const MAX_BYTES = 3.8 * 1024 * 1024;
const BITRATE = 48_000;
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"];

/** Whether this browser can record a voice report at all. */
export function voiceSupport(): "ok" | "insecure" | "unsupported" {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  if (typeof window.MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return "unsupported";
  return "ok";
}

interface Session {
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  context: AudioContext | null;
  chunks: Blob[];
  bytes: number;
  startedAt: number;
  ticker: ReturnType<typeof setInterval> | undefined;
  stopGuard: ReturnType<typeof setTimeout> | undefined;
  wakeLock: WakeLockSentinel | null;
  cleanups: (() => void)[];
  stopping: boolean;
  /** Mic and audio released. Nothing from this session may change state after this. */
  closed: boolean;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return MIME_TYPES.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

function createRecorder(stream: MediaStream): MediaRecorder | null {
  const mimeType = pickMimeType();
  const attempts: MediaRecorderOptions[] = mimeType
    ? [{ mimeType, audioBitsPerSecond: BITRATE }, { mimeType }, {}]
    : [{ audioBitsPerSecond: BITRATE }, {}];
  for (const options of attempts) {
    try {
      return new MediaRecorder(stream, options);
    } catch {
      // Try simpler options.
    }
  }
  return null;
}

function resume(context: AudioContext) {
  try {
    void Promise.resolve(context.resume()).catch(() => undefined);
  } catch {
    // The meter just stays flat.
  }
}

// Runs inside the tap: iOS keeps an AudioContext suspended unless it starts in a user gesture.
function createAudioContext(): AudioContext | null {
  const Context =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  try {
    const context = new Context();
    resume(context);
    return context;
  } catch {
    return null;
  }
}

/** Live level for the ASCII meter. Purely visual: any failure leaves the meter flat. */
function connectMeter(context: AudioContext | null, stream: MediaStream): AnalyserNode | null {
  if (!context) return null;
  try {
    if (context.state !== "running") resume(context);
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    // Safari only pulls audio through nodes that reach the output. A zero gain keeps it silent.
    const silent = context.createGain();
    silent.gain.value = 0;
    analyser.connect(silent);
    silent.connect(context.destination);
    return analyser;
  } catch {
    return null;
  }
}

// Keeps the phone from locking mid-report (auto-lock would cut the mic).
function requestWakeLock(session: Session) {
  if (!("wakeLock" in navigator)) return;
  navigator.wakeLock.request("screen").then(
    (lock) => {
      if (session.closed) void lock.release().catch(() => undefined);
      else session.wakeLock = lock;
    },
    () => undefined, // not allowed right now: recording still works
  );
}

/** Releases the mic, the audio graph, timers and the screen lock. Safe to call twice. */
function release(session: Session) {
  if (session.closed) return;
  session.closed = true;
  clearInterval(session.ticker);
  clearTimeout(session.stopGuard);
  for (const cleanup of session.cleanups.splice(0)) cleanup();
  const recorder = session.recorder;
  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Already stopping.
      }
    }
  }
  session.stream?.getTracks().forEach((track) => track.stop());
  if (session.context && session.context.state !== "closed") session.context.close().catch(() => undefined);
  session.wakeLock?.release().catch(() => undefined);
  session.wakeLock = null;
}

function micProblem(error: unknown): MicProblem {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "missing";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "failed";
}

export function useVoiceRecorder(handlers: {
  onRecorded: (recording: Recording) => void;
  /** Under a second (an accidental double tap): nothing is sent. */
  onTooShort: () => void;
  onProblem: (problem: MicProblem) => void;
}) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const handlersRef = useRef(handlers);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  // Closing the sheet unmounts this hook: never leave the mic on.
  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) release(session);
    };
  }, []);

  const end = (session: Session) => {
    release(session);
    if (sessionRef.current === session) sessionRef.current = null;
    setPhase("idle");
    setSeconds(0);
    setAnalyser(null);
  };

  const finish = (session: Session) => {
    if (session.closed) return;
    const durationMs = performance.now() - session.startedAt;
    const type = session.recorder?.mimeType || session.chunks[0]?.type || "audio/webm";
    const blob = new Blob(session.chunks, { type });
    end(session);
    if (durationMs < MIN_RECORDING_MS || blob.size < MIN_BYTES) handlersRef.current.onTooShort();
    else handlersRef.current.onRecorded({ blob, durationMs });
  };

  /** Finishes the recording and hands it over. While the permission prompt is up, gives up quietly. */
  const stop = () => {
    const session = sessionRef.current;
    if (!session || session.stopping) return;
    const recorder = session.recorder;
    if (!recorder) {
      end(session);
      return;
    }
    session.stopping = true;
    clearInterval(session.ticker);
    if (recorder.state === "inactive") {
      finish(session);
      return;
    }
    try {
      recorder.stop(); // a last dataavailable, then stop
    } catch {
      finish(session);
      return;
    }
    // Some Safari versions never fire stop after an interruption: finish with what we have.
    session.stopGuard = setTimeout(() => finish(session), 4000);
  };

  /** Throws the recording away and releases the mic. */
  const cancel = () => {
    const session = sessionRef.current;
    if (session) end(session);
  };

  const begin = (session: Session, stream: MediaStream) => {
    session.stream = stream;
    const recorder = createRecorder(stream);
    if (!recorder) {
      end(session);
      handlersRef.current.onProblem("unsupported");
      return;
    }
    session.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (!event.data || !event.data.size) return;
      session.chunks.push(event.data);
      session.bytes += event.data.size;
      if (session.bytes >= MAX_BYTES) stop();
    };
    recorder.onstop = () => finish(session);
    recorder.onerror = () => {
      if (session.chunks.length) {
        finish(session);
      } else {
        end(session);
        handlersRef.current.onProblem("failed");
      }
    };

    // Locking the phone, a call or switching apps ends capture on iOS: keep what was said so far.
    // Desktop browsers keep recording in a background tab, so a tab switch there must not end it.
    if (window.matchMedia("(any-pointer: coarse)").matches) {
      const onHide = () => {
        if (document.visibilityState === "hidden") stop();
      };
      document.addEventListener("visibilitychange", onHide);
      session.cleanups.push(() => document.removeEventListener("visibilitychange", onHide));
    }
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", stop);
      session.cleanups.push(() => track.removeEventListener("ended", stop));
    }

    try {
      recorder.start(1000); // chunks every second, so the size check works and an error keeps what came before
    } catch {
      end(session);
      handlersRef.current.onProblem("failed");
      return;
    }
    session.startedAt = performance.now();
    session.ticker = setInterval(() => {
      const elapsed = performance.now() - session.startedAt;
      setSeconds(Math.floor(elapsed / 1000));
      if (elapsed >= MAX_RECORDING_MS) stop();
    }, 250);
    setAnalyser(connectMeter(session.context, stream));
    requestWakeLock(session);
    setSeconds(0);
    setPhase("recording");
  };

  /** Call straight from a tap or key press: the browser only allows the mic and audio from a gesture. */
  const start = () => {
    if (sessionRef.current) return;
    const support = voiceSupport();
    if (support !== "ok") {
      handlersRef.current.onProblem(support);
      return;
    }
    const session: Session = {
      stream: null,
      recorder: null,
      context: createAudioContext(),
      chunks: [],
      bytes: 0,
      startedAt: 0,
      ticker: undefined,
      stopGuard: undefined,
      wakeLock: null,
      cleanups: [],
      stopping: false,
      closed: false,
    };
    sessionRef.current = session;
    setPhase("starting");

    let request: Promise<MediaStream>;
    try {
      request = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      (stream) => {
        if (session.closed) {
          // Cancelled or closed while the permission prompt was up.
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        begin(session, stream);
      },
      (error) => {
        if (session.closed) return;
        end(session);
        handlersRef.current.onProblem(micProblem(error));
      },
    );
  };

  return { phase, seconds, analyser, start, stop, cancel };
}
