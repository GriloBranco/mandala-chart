"use client";

import { useRef, useState } from "react";
import { ApiError } from "@/client/api";
import { toast } from "@/client/toast";
import { importBackup } from "./requests";

/**
 * "Import a backup": picks a "Download my data" file and loads it into this account (the server
 * accepts it only while the account is empty), then reloads so every screen shows it.
 * Render `input` once and call `pick` from a button.
 */
export function useImportBackup() {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const load = async (file: File) => {
    setBusy(true);
    try {
      const { goals, reports } = await importBackup(file);
      toast(`Imported ${goals} ${goals === 1 ? "goal" : "goals"} and ${reports} ${reports === 1 ? "report" : "reports"}`);
      setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      setBusy(false);
      // 401 is already on its way to the sign-in page.
      if (error instanceof ApiError && error.status === 401) return;
      const message =
        error instanceof ApiError
          ? error.offline
            ? "You're offline. Try again when you're back."
            : error.message
          : "Could not import this file. Try again.";
      toast(message, { tone: "error" });
    }
  };

  const input = (
    <input
      ref={ref}
      type="file"
      accept="application/json,.json"
      className="hidden"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = ""; // the same file can be picked again after a fix
        if (file) void load(file);
      }}
    />
  );

  return { busy, input, pick: () => ref.current?.click() };
}
