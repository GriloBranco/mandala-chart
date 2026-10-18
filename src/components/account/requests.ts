// Account calls: delete the account (the password goes in the body) and download a copy as a
// file. Both go through src/client/api.ts, so they check the page's account and handle 401 like
// every other call. Errors are ApiErrors with the server's message.

import { api, apiFetch, ApiError } from "@/client/api";
import { dayKey } from "@/domain/mandala";

async function failure(response: Response): Promise<ApiError> {
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  return new ApiError(response.status, data?.error ?? `Request failed (${response.status})`);
}

/** Deletes the account and everything in it. The server checks the password first. */
export async function deleteAccount(password: string): Promise<void> {
  await api.delete("/api/me", { password });
}

/** Saves everything in the account as a JSON file. */
export async function downloadExport(): Promise<void> {
  const response = await apiFetch("/api/me/export");
  if (!response.ok) throw await failure(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName(response.headers.get("Content-Disposition"));
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Safari reads the file after click() returns, so the link must stay valid for a while.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function fileName(header: string | null): string {
  const match = header ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header) : null;
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return `mandala-${dayKey()}.json`;
}
