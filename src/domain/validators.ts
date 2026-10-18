import { z } from "zod";
import { NOTES_MAX } from "./mandala";

export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const pillarIndex = z.number().int().min(0).max(7);
const rating = z.number().int().min(1).max(3).nullable();

export const createGoalSchema = z.object({
  /** Chosen by the client, so a retry after a lost response returns the same goal. */
  id: z.uuid().optional(),
  title: z.string().trim().min(1).max(200),
  why: z.string().max(2000).optional(),
  deadline: daySchema.nullable().optional(),
  pillars: z.array(z.string().max(120)).max(8).optional(),
});

export const goalPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    why: z.string().max(2000).optional(),
    deadline: daySchema.nullable().optional(),
    status: z.enum(["active", "achieved", "archived"]).optional(),
    position: z.number().finite().optional(),
  })
  .strict();

export const cellPatchSchema = z
  .object({
    text: z.string().max(200).optional(),
    notes: z.string().max(NOTES_MAX).optional(),
    kind: z.enum(["task", "habit"]).optional(),
    status: z.enum(["todo", "doing", "done"]).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    impact: rating.optional(),
    effort: rating.optional(),
    helps: z.array(pillarIndex).max(7).optional(),
    active: z.boolean().optional(),
    /** Only used with active: true, so Undo can restore the original start. */
    activatedAt: z.iso.datetime().nullable().optional(),
    /** Only used with status "done", so Undo can restore the original finish time. */
    doneAt: z.iso.datetime().nullable().optional(),
  })
  .strict();

export const cellBatchSchema = z.object({
  updates: z.array(z.object({ id: z.string().min(1), patch: cellPatchSchema })).min(1).max(100),
});

export const checkinSchema = z.object({
  cellId: z.string().min(1),
  day: daySchema,
  done: z.boolean(),
});

export const proposedUpdateSchema = z.object({
  cellId: z.string().min(1),
  status: z.enum(["todo", "doing", "done"]).optional(),
  checkin: z.boolean().optional(),
  note: z.string().max(500).optional(),
  quote: z.string().max(500).default(""),
  confidence: z.number().min(0).max(1).default(1),
});

export const saveReportSchema = z.object({
  /** Chosen by the client, so a retry after a lost response does not save the report twice. */
  id: z.uuid().optional(),
  goalId: z.string().min(1).nullable(),
  source: z.enum(["voice", "text"]),
  transcript: z.string().trim().min(1).max(20000),
  summary: z.string().max(1000).default(""),
  day: daySchema,
  updates: z.array(proposedUpdateSchema).max(64),
});

// ---------- accounts ----------

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: "Enter a valid email." }).max(254, "That email is too long."));

export const newPasswordSchema = z
  .string()
  .min(8, "Use at least 8 characters for the password.")
  .max(200, "That password is too long.");

export const signupSchema = z.object({
  email: emailSchema,
  password: newPasswordSchema,
  /** Only checked when SIGNUP_CODE is set on the server (invite-only mode). */
  code: z.string().max(200).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().max(254),
  password: z.string().max(200),
});

export const accountPatchSchema = z.object({
  headline: z.string().trim().max(160),
});

export const changePasswordSchema = z.object({
  current: z.string().max(200),
  next: newPasswordSchema,
});

export const deleteAccountSchema = z.object({
  password: z.string().max(200),
});
