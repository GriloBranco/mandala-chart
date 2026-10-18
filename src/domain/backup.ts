import { z } from "zod";
import { NOTES_MAX } from "./mandala";
import { daySchema } from "./validators";

// The file "Download my data" writes and "Import a backup" reads. The same shape for every
// version of the app, so a backup from the personal app moves into an account here.

export const BACKUP_FORMAT = "mandala-backup";
export const BACKUP_VERSION = 1;
/** Larger files are refused before they are read (the host caps request bodies at 4.5 MB). */
export const BACKUP_MAX_BYTES = 4_000_000;

const id = z.string().min(1).max(200);
/** Any time a browser can read, saved the way the app writes times. */
const time = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Not a date")
  .transform((value) => new Date(value).toISOString());
const rating = z.number().int().min(1).max(3).nullable();

const cellSchema = z.object({
  id,
  pillar: z.number().int().min(0).max(7),
  slot: z.number().int().min(-1).max(7),
  text: z.string().max(200),
  notes: z.string().max(NOTES_MAX),
  kind: z.enum(["task", "habit"]),
  status: z.enum(["todo", "doing", "done"]),
  progress: z.number().int().min(0).max(100),
  impact: rating,
  effort: rating,
  helps: z.array(z.number().int().min(0).max(7)).max(7),
  active: z.boolean(),
  activatedAt: time.nullable(),
  doneAt: time.nullable().default(null),
  updatedAt: time,
});

const goalSchema = z.object({
  id,
  title: z.string().max(200),
  why: z.string().max(2000),
  deadline: daySchema.nullable(),
  status: z.enum(["active", "achieved", "archived"]),
  position: z.number().finite(),
  createdAt: time,
  updatedAt: time,
  cells: z.array(cellSchema).max(72),
});

const reportSchema = z.object({
  id,
  goalId: id.nullable(),
  source: z.enum(["voice", "text"]),
  transcript: z.string().max(20000),
  summary: z.string().max(1000),
  day: daySchema,
  createdAt: time,
});

const eventSchema = z.object({
  id,
  goalId: id,
  cellId: id.nullable(),
  reportId: id.nullable(),
  type: z.enum(["status", "progress", "note", "checkin", "report", "goal"]),
  detail: z.string().max(4000),
  createdAt: time,
});

const checkinSchema = z.object({ cellId: id, goalId: id, day: daySchema });

export const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT).optional(),
  version: z.literal(BACKUP_VERSION).optional(),
  account: z.object({ headline: z.string().max(160).optional() }).partial().optional(),
  goals: z.array(goalSchema).max(50),
  reports: z.array(reportSchema).max(10_000).default([]),
  events: z.array(eventSchema).max(100_000).default([]),
  checkins: z.array(checkinSchema).max(100_000).default([]),
});

export type Backup = z.infer<typeof backupSchema>;
