// Account calls: delete the account (the password goes in the body), download a copy as a file
// and import one. All go through src/client/api.ts, so they check the page's account and handle
// 401 like every other call. Errors are ApiErrors with the server's message.

import { api, apiFetch, ApiError } from "@/client/api";
import { BACKUP_MAX_BYTES } from "@/domain/backup";
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

const NOT_A_BACKUP = "This file is not a Mandala backup. Use the file from \"Download my data\".";

/** Loads a "Download my data" file into this account, which must be empty. */
export async function importBackup(file: File): Promise<{ goals: number; reports: number }> {
  if (file.size > BACKUP_MAX_BYTES) throw new ApiError(413, "This file is too large to import.");
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new ApiError(400, NOT_A_BACKUP);
  }
  try {
    return await api.post<{ goals: number; reports: number }>("/api/me/import", data);
  } catch (error) {
    // The server's 400 lists schema issues; the person needs to know it is the wrong file.
    if (error instanceof ApiError && error.status === 400) throw new ApiError(400, NOT_A_BACKUP);
    throw error;
  }
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
