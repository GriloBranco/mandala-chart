"use client";

import { ChevronDown, Download, KeyRound, LogOut, MonitorSmartphone, Trash2, Upload } from "lucide-react";
import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { AsciiSpinner } from "@/components/ascii/AsciiSpinner";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { cleanHeadline, HEADLINE, HEADLINE_MAX, saveHeadline } from "@/components/shell/Headline";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Sheet } from "@/components/ui/Sheet";
import { api, ApiError } from "@/client/api";
import { actions, clearLocalData, getState, useAppState } from "@/client/store";
import { toast } from "@/client/toast";
import { errorText, PasswordInput } from "./fields";
import { deleteAccount, downloadExport } from "./requests";
import { useImportBackup } from "./useImportBackup";

const LABEL = "font-mono text-[10.5px] tracking-[0.14em] text-faint uppercase";

/** Email, the line on Today, password, a copy of the data, sign out (here or everywhere), and delete. */
export function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Account">
      <AccountBody />
    </Sheet>
  );
}

function AccountBody() {
  const { user } = useAppState();
  const email = user?.email ?? "";
  return (
    <div className="pb-1">
      <section>
        <h3 className={LABEL}>Email</h3>
        <p className="mt-1.5 text-[15px] leading-snug break-all text-fg">{email || "–"}</p>
      </section>

      <LineSection />

      <div className="mt-6 border-t border-line pt-2">
        <div className="-mx-3">
          <PasswordSection email={email} />
          <DownloadRow />
          <ImportRow />
          <SignOutRow />
          <SignOutEverywhereSection />
        </div>
      </div>

      <DeleteSection email={email} />
    </div>
  );
}

// ---------- your line ----------

function LineSection() {
  const { user } = useAppState();
  const saved = user?.headline ?? "";
  // Null until they type, so the box always shows the saved line otherwise.
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const value = draft ?? saved;
  const dirty = draft !== null && cleanHeadline(draft) !== saved;

  const save = async () => {
    const submitted = draft;
    if (submitted === null) return;
    // Text typed while the save is on its way stays in the box.
    const settle = () => setDraft((current) => (current === submitted ? null : current));
    const line = cleanHeadline(submitted);
    // Read the store now, not this render: a blur may have saved it a moment ago.
    if (line === (getState().user?.headline ?? "")) {
      settle();
      return;
    }
    if (await saveHeadline(line)) {
      settle();
      toast(line ? "Your line is saved" : "Back to the default line");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape" && draft !== null) {
      // The first Esc puts the saved line back; the next one closes the sheet.
      event.stopPropagation();
      setDraft(null);
    }
  };

  return (
    <section className="mt-6">
      <label htmlFor={id} className={LABEL}>
        Your line
      </label>
      <AutoTextarea
        id={id}
        value={value}
        onChange={(next) => setDraft(next.replace(/\s*\n\s*/g, " "))}
        onKeyDown={onKeyDown}
        onBlur={() => void save()}
        maxRows={4}
        maxLength={HEADLINE_MAX}
        enterKeyHint="done"
        placeholder={HEADLINE}
        className="mt-2 rounded-xl border border-line-strong bg-bg px-4 py-3 text-[15px] leading-snug text-fg outline-none! transition-colors placeholder:text-faint focus:border-fg"
      />
      <div className="mt-1.5 flex items-start justify-between gap-3">
        <p className="text-[12.5px] leading-snug text-muted">At the top of Today. Leave it empty for the default.</p>
        <span className="shrink-0 pt-px font-mono text-[11px] text-faint">
          {value.length}/{HEADLINE_MAX}
        </span>
      </div>
      {dirty && (
        <div className="mt-2 flex justify-end">
          {/* Pressing it must not blur the box first: that would save before the click lands. */}
          <Button variant="primary" onMouseDown={(event) => event.preventDefault()} onClick={() => void save()}>
            Save
          </Button>
        </div>
      )}
    </section>
  );
}

// ---------- rows ----------

function Row({
  icon,
  label,
  onClick,
  busy = false,
  expanded,
  danger = false,
  aside,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  busy?: boolean;
  /** Set for rows that open a small form below them. */
  expanded?: boolean;
  danger?: boolean;
  aside?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-expanded={expanded}
      className={cn(
        "flex h-12 w-full items-center gap-3.5 rounded-xl px-3 text-left text-[15px] transition-colors hover:bg-soft active:bg-soft disabled:pointer-events-none",
        danger ? "text-danger" : "text-fg",
      )}
    >
      <span className={cn("grid w-5 shrink-0 place-items-center", danger ? "text-danger" : "text-muted")}>
        {busy ? <AsciiSpinner size="sm" label="Working" /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {aside}
      {expanded !== undefined && (
        <ChevronDown size={16} className={cn("shrink-0 text-faint transition-transform", expanded && "rotate-180")} />
      )}
    </button>
  );
}

function FormError({ message }: { message: string | null }) {
  return (
    <p role="alert" className={cn("text-[13.5px] leading-snug text-danger", message && "mt-2.5")}>
      {message}
    </p>
  );
}

// ---------- password ----------

function PasswordSection({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row
        icon={<KeyRound size={17} />}
        label="Change password"
        expanded={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open && <PasswordForm email={email} onDone={() => setOpen(false)} />}
    </>
  );
}

function PasswordForm({ email, onDone }: { email: string; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!current) {
      setError("Enter your current password.");
      return;
    }
    if (next.length < 8) {
      setError("Use at least 8 characters for the new password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Edits on their way carry the old session, which stops working once the password changes.
      await actions.synced();
      await api.post("/api/me/password", { current, next });
      toast("Password changed. Other devices are signed out.");
      onDone();
    } catch (err) {
      setError(errorText(err, "Could not change the password."));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="px-3 pt-1 pb-4">
      {/* Tells password managers which account the new password belongs to. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <div className="space-y-2.5">
        <PasswordInput
          name="current-password"
          label="Current password"
          placeholder="Current password"
          autoComplete="current-password"
          maxLength={200}
          value={current}
          onChange={setCurrent}
          readOnly={busy}
          autoFocus
        />
        <PasswordInput
          name="new-password"
          label="New password"
          placeholder="New password (8+ characters)"
          autoComplete="new-password"
          maxLength={200}
          value={next}
          onChange={setNext}
          readOnly={busy}
        />
      </div>
      <FormError message={error} />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Change password
        </Button>
      </div>
    </form>
  );
}

// ---------- download ----------

function DownloadRow() {
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      // Edits still on their way go first, so the file has everything on screen.
      await actions.synced();
      await downloadExport();
    } catch (error) {
      // 401 is already on its way to the sign-in page.
      if (!(error instanceof ApiError && error.status === 401)) {
        toast(
          error instanceof ApiError && error.offline
            ? "You're offline. Try again when you're back."
            : "Could not download your data. Try again.",
          { tone: "error" },
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row
      icon={<Download size={17} />}
      label={busy ? "Preparing your file…" : "Download my data"}
      aside={<span className="shrink-0 font-mono text-[11px] text-faint">JSON</span>}
      busy={busy}
      onClick={() => void download()}
    />
  );
}

/** Only offered while the account is empty: the server refuses an import into one with data. */
function ImportRow() {
  const { goals, status } = useAppState();
  const { busy, input, pick } = useImportBackup();
  if (status !== "ready" || (goals.length > 0 && !busy)) return null;
  return (
    <>
      {input}
      <Row
        icon={<Upload size={17} />}
        label={busy ? "Importing…" : "Import a backup"}
        aside={<span className="shrink-0 font-mono text-[11px] text-faint">JSON</span>}
        busy={busy}
        onClick={pick}
      />
    </>
  );
}

// ---------- sign out ----------

/**
 * Ends the session (on every device when asked), then forgets this account on this device.
 * False when the person kept their unsaved changes instead. Throws when the server said no.
 */
async function signOut(everywhere: boolean): Promise<boolean> {
  // Send waiting edits first: signing out also deletes the copy kept on this device.
  if (!(await actions.synced()) && !window.confirm("Some changes are not saved yet. Sign out and lose them?")) {
    return false;
  }
  try {
    await api.post("/api/auth/logout", everywhere ? { everywhere: true } : undefined);
  } catch (error) {
    // 401: the session had already ended, so carry on and clear this device.
    if (!(error instanceof ApiError && error.status === 401)) throw error;
  }
  // The store saves nothing more after this, so a sync still on its way cannot bring it back.
  clearLocalData();
  window.location.replace("/login");
  return true;
}

function SignOutRow() {
  const [signingOut, setSigningOut] = useState(false);

  const run = async () => {
    setSigningOut(true);
    try {
      if (!(await signOut(false))) setSigningOut(false);
    } catch {
      setSigningOut(false);
      toast("Could not sign out. Check your connection and try again.", { tone: "error" });
    }
  };

  return (
    <Row
      icon={<LogOut size={17} />}
      label={signingOut ? "Signing out…" : "Sign out"}
      busy={signingOut}
      onClick={() => void run()}
    />
  );
}

function SignOutEverywhereSection() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row
        icon={<MonitorSmartphone size={17} />}
        label="Sign out everywhere"
        expanded={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open && <SignOutEverywhereForm onCancel={() => setOpen(false)} />}
    </>
  );
}

function SignOutEverywhereForm({ onCancel }: { onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await signOut(true))) setBusy(false);
    } catch (err) {
      setError(errorText(err, "Could not sign out everywhere."));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="px-3 pt-1 pb-4">
      <p className="text-[13.5px] leading-relaxed text-muted">
        Signs you out on every phone and computer, this one too. Use it if you are still signed in on a device
        you can&apos;t reach.
      </p>
      <FormError message={error} />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Sign out everywhere
        </Button>
      </div>
    </form>
  );
}

// ---------- delete ----------

function DeleteSection({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 border-t border-line pt-2">
      <div className="-mx-3">
        <Row
          icon={<Trash2 size={17} />}
          label="Delete account"
          danger
          expanded={open}
          onClick={() => setOpen((value) => !value)}
        />
      </div>
      {open && <DeleteForm email={email} onCancel={() => setOpen(false)} />}
    </div>
  );
}

function DeleteForm({ email, onCancel }: { email: string; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!password) {
      setError("Enter your password to confirm.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Edits already on their way land first, so none reaches the server after the account is gone.
      await actions.synced();
      await deleteAccount(password);
    } catch (err) {
      setError(errorText(err, "Could not delete the account."));
      setBusy(false);
      return;
    }
    clearLocalData();
    window.location.replace("/login?new=1");
  };

  return (
    <form onSubmit={submit} noValidate className="pt-1 pb-2">
      <p className="text-[13.5px] leading-relaxed text-muted">
        This deletes your account with every goal, report and check-in. It can&apos;t be undone. Download your
        data first if you want a copy.
      </p>
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <PasswordInput
        className="mt-3"
        name="password"
        label="Password"
        placeholder="Your password"
        autoComplete="current-password"
        maxLength={200}
        value={password}
        onChange={setPassword}
        readOnly={busy}
        autoFocus
      />
      <FormError message={error} />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          icon={<Trash2 size={15} />}
          className="bg-danger! hover:bg-danger/90!"
        >
          Delete my account
        </Button>
      </div>
    </form>
  );
}
