"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { AsciiMandala } from "@/components/ascii/AsciiMandala";
import { errorText, fieldClass, PasswordInput } from "@/components/account/fields";
import { Headline } from "@/components/shell/Headline";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { api, ApiError } from "@/lib/api-client";

type Mode = "signin" | "signup";

interface AuthConfig {
  ready: boolean;
  signupsOpen: boolean;
  inviteOnly: boolean;
}

// Used until the server answers, and when it cannot be reached.
const USUAL: AuthConfig = { ready: true, signupsOpen: true, inviteOnly: false };

// Set after a sign-in on this device, so people who know the app skip the intro lines.
// It is not one of the "mandala:" keys on purpose: signing out clears those, not this.
const RETURNING_KEY = "mandala-returning";

const METHOD: [string, string][] = [
  ["1", "goal in the middle"],
  ["8", "pillars around it"],
  ["64", "small actions. Pick 5-8 a week and report daily."],
];

const noop = () => () => {};

function safeNext(): string {
  const raw = new URLSearchParams(window.location.search).get("next");
  if (!raw) return "/";
  try {
    // Let the browser resolve it, then keep it only if it stays on this site. Return the full
    // URL: a path such as "//evil.com" (which "/.//evil.com" resolves to) means another site.
    const url = new URL(raw, window.location.origin);
    return url.origin === window.location.origin && url.pathname !== "/login" ? url.href : "/";
  } catch {
    return "/";
  }
}

function modeInUrl(): Mode {
  return new URLSearchParams(window.location.search).get("new") === "1" ? "signup" : "signin";
}

function returningDevice(): boolean {
  try {
    return window.localStorage.getItem(RETURNING_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDevice() {
  try {
    window.localStorage.setItem(RETURNING_KEY, "1");
  } catch {
    // Private mode: the intro lines just show again next time.
  }
}

export function LoginScreen() {
  // Both read the browser. The server render assumes Sign in and a returning visitor, and
  // only adds content below the form, which is still hidden while the page fades in.
  const urlMode = useSyncExternalStore<Mode>(noop, modeInUrl, () => "signin");
  const returning = useSyncExternalStore(noop, returningDevice, () => true);
  // False in the server's HTML. Until the page script runs, the form must not submit itself.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const [picked, setPicked] = useState<Mode | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    let live = true;
    api
      .get<AuthConfig>("/api/auth/config")
      .then((value) => {
        if (live) setConfig(value);
      })
      .catch(() => {
        if (live) setConfig(USUAL);
      });
    return () => {
      live = false;
    };
  }, []);

  const settings = config ?? USUAL;
  const wanted = picked ?? urlMode;
  const mode: Mode = settings.signupsOpen ? wanted : "signin";
  const signup = mode === "signup";
  const needsCode = signup && settings.inviteOnly;

  const pick = (next: Mode) => {
    setPicked(next);
    setError(null);
  };

  const stop = (message: string, field: HTMLInputElement | null) => {
    setError(message);
    field?.focus();
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!email.trim()) return stop("Enter your email.", emailRef.current);
    if (!password) return stop("Enter your password.", passwordRef.current);
    if (signup && password.length < 8) {
      return stop("Use at least 8 characters for the password.", passwordRef.current);
    }
    if (needsCode && !code.trim()) return stop("Enter your invite code.", codeRef.current);
    setBusy(true);
    setError(null);
    try {
      const body = { email: email.trim(), password, ...(needsCode ? { code: code.trim() } : {}) };
      await api.post(signup ? "/api/auth/signup" : "/api/auth/login", body);
      rememberDevice();
      window.location.replace(safeNext());
    } catch (err) {
      setBusy(false);
      setError(errorText(err, signup ? "Could not create the account." : "Could not sign in."));
      // Wrong password or invite code: ready to type it again.
      const status = err instanceof ApiError ? err.status : 0;
      const retype = status === 401 ? passwordRef.current : status === 403 ? codeRef.current : null;
      retype?.focus();
      retype?.select();
    }
  }

  const form = (
    // method="post": a submit before the script runs (a fast tap, a password manager) must
    // never put the password in the address bar. The page just shows again.
    <form method="post" onSubmit={submit} noValidate aria-label={signup ? "Create account" : "Sign in"}>
      {settings.signupsOpen && <ModeSwitch mode={mode} onPick={pick} />}
      <div className={cn("space-y-2.5", settings.signupsOpen && "mt-4")}>
        <label htmlFor={`${id}-email`} className="sr-only">
          Email
        </label>
        <input
          ref={emailRef}
          id={`${id}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={254}
          placeholder="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          readOnly={busy}
          className={fieldClass("pill")}
        />
        <PasswordInput
          ref={passwordRef}
          id={`${id}-password`}
          name="password"
          label="Password"
          shape="pill"
          autoComplete={signup ? "new-password" : "current-password"}
          placeholder={signup ? "Password (8+ characters)" : "Password"}
          maxLength={200}
          value={password}
          onChange={setPassword}
          readOnly={busy}
        />
        {needsCode && (
          <>
            <label htmlFor={`${id}-code`} className="sr-only">
              Invite code
            </label>
            <input
              ref={codeRef}
              id={`${id}-code`}
              name="invite-code"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={200}
              placeholder="Invite code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              readOnly={busy}
              className={fieldClass("pill")}
            />
          </>
        )}
      </div>
      {/* Off until the script runs, which also stops Enter from sending the plain form. */}
      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={busy}
        disabled={!hydrated}
        className="mt-4 w-full disabled:opacity-100!"
      >
        {signup ? (busy ? "Creating account…" : "Create account") : busy ? "Signing in…" : "Sign in"}
      </Button>
      <p role="alert" className="mt-3 min-h-5 text-center text-[13.5px] leading-snug text-danger">
        {error}
      </p>
    </form>
  );

  return (
    <main className="min-h-dvh px-6 pt-[calc(var(--safe-top)+36px)] pb-[calc(var(--safe-bottom)+40px)] lg:px-12 lg:pt-[max(48px,calc(50dvh-300px))]">
      <div className="mx-auto flex w-full max-w-sm flex-col items-center lg:grid lg:max-w-[940px] lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-x-24">
        <div className="flex w-full flex-col items-center">
          <AsciiMandala
            intro
            className="w-[min(280px,68vw,34dvh)] lg:w-[min(420px,52dvh)]"
            label="Mandala logo: one goal at the center of a nine by nine grid"
          />
          {/* The left padding balances the tracking after the last letter, so the word sits centered. */}
          <p className="mt-7 animate-rise pl-[0.42em] font-mono text-[13px] font-medium tracking-[0.42em] text-fg [animation-delay:900ms]">
            MANDALA
          </p>
          <Headline className="mt-4 max-w-[340px] text-center text-[19px] leading-[1.25] lg:max-w-[400px] lg:text-[22px]" />
        </div>

        <div className="mt-9 w-full lg:mt-0 lg:pt-14">
          <div className="animate-rise [animation-delay:1300ms]">
            {settings.ready ? (
              form
            ) : (
              <p className="py-6 text-center text-[15px] text-muted">Sign-in isn&apos;t set up yet.</p>
            )}
          </div>
          {(!returning || wanted === "signup") && (
            <Intro signupsOpen={settings.signupsOpen} delay={picked === null ? 1500 : 0} />
          )}
        </div>
      </div>
    </main>
  );
}

/** Two halves of one pill. Each half is a full 44px tap target. */
function ModeSwitch({ mode, onPick }: { mode: Mode; onPick: (mode: Mode) => void }) {
  const options: [Mode, string][] = [
    ["signin", "Sign in"],
    ["signup", "Create account"],
  ];
  return (
    <div role="group" aria-label="Sign in or create an account" className="grid grid-cols-2 rounded-full bg-soft">
      {options.map(([value, label]) => {
        const selected = value === mode;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={selected}
            onClick={() => onPick(value)}
            className="group h-11 rounded-full p-1 text-[14px] font-medium"
          >
            <span
              className={cn(
                "flex h-full items-center justify-center rounded-full transition-[background-color,color,box-shadow] duration-150",
                selected ? "bg-bg text-fg shadow-[0_0_0_1px_var(--line-strong)]" : "text-muted group-hover:text-fg",
              )}
            >
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** For people new here: the method in three lines, and what happens to their data. */
function Intro({ signupsOpen, delay }: { signupsOpen: boolean; delay: number }) {
  return (
    <div className="mt-4 animate-rise" style={{ animationDelay: `${delay}ms` }}>
      <ol className="space-y-2">
        {METHOD.map(([number, text]) => (
          <li key={number} className="flex items-baseline gap-3.5">
            <span className="w-6 shrink-0 text-right font-mono text-[13px] font-medium text-fg">{number}</span>
            <span className="text-[14.5px] leading-snug text-muted">{text}</span>
          </li>
        ))}
      </ol>
      <p className="mt-5 border-t border-line pt-4 text-[13px] leading-relaxed text-muted">
        Your goals are private to your account. Voice notes are transcribed by Gemini and never stored.
      </p>
      {!signupsOpen && <p className="mt-2 text-[13px] leading-relaxed text-muted">New accounts are closed right now.</p>}
    </div>
  );
}
