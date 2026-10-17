// Shared by the server (API) and the client (store, UI).

export type GoalStatus = "active" | "achieved" | "archived";
export type CellKind = "task" | "habit";
export type CellStatus = "todo" | "doing" | "done";
export type ReportSource = "voice" | "text";
export type EventType = "status" | "progress" | "note" | "checkin" | "report" | "goal";

export interface Goal {
  id: string;
  title: string;
  why: string;
  deadline: string | null;
  status: GoalStatus;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** One square of the chart. slot -1 is the pillar itself; slots 0-7 are its actions. */
export interface Cell {
  id: string;
  goalId: string;
  pillar: number;
  slot: number;
  text: string;
  notes: string;
  kind: CellKind;
  status: CellStatus;
  progress: number;
  /** 1-3. How much this moves the goal (for a pillar) or its pillar (for an action). */
  impact: number | null;
  /** 1-3. 1 is easy. Actions only. */
  effort: number | null;
  /** Other pillars (0-7) this square also helps. The video's "synergy". */
  helps: number[];
  /** Picked into the weekly rollout: shows on Today until done. */
  active: boolean;
  activatedAt: string | null;
  /** When the status last became done (null when not done). */
  doneAt: string | null;
  updatedAt: string;
}

export interface GoalWithCells extends Goal {
  cells: Cell[];
}

export interface Checkin {
  cellId: string;
  goalId: string;
  day: string;
}

export interface Report {
  id: string;
  goalId: string | null;
  source: ReportSource;
  transcript: string;
  summary: string;
  day: string;
  createdAt: string;
}

export interface ProgressEvent {
  id: string;
  goalId: string;
  cellId: string | null;
  reportId: string | null;
  type: EventType;
  detail: string;
  createdAt: string;
}

export interface Account {
  id: string;
  email: string;
  /** The line at the top of Today; empty means the default one. */
  headline: string;
}

export interface AppState {
  user: Account;
  goals: GoalWithCells[];
  checkins: Checkin[];
  aiEnabled: boolean;
}

export type CellPatch = Partial<
  Pick<
    Cell,
    | "text"
    | "notes"
    | "kind"
    | "status"
    | "progress"
    | "impact"
    | "effort"
    | "helps"
    | "active"
    | "activatedAt"
    | "doneAt"
  >
>;

export type GoalPatch = Partial<Pick<Goal, "title" | "why" | "deadline" | "status" | "position">>;

/** A change the AI proposes from a report. The user confirms it before it is applied. */
export interface ProposedUpdate {
  cellId: string;
  status?: CellStatus;
  /** Habits only: mark the report's day as done. */
  checkin?: boolean;
  note?: string;
  /** The words from the report that support this change. */
  quote: string;
  /** 0-1. Low-confidence updates start unchecked in the review. */
  confidence: number;
}

export interface ReportAnalysis {
  transcript: string;
  summary: string;
  updates: ProposedUpdate[];
}

export interface ReportWithEvents extends Report {
  events: ProgressEvent[];
}

export interface Suggestion {
  text: string;
  kind?: CellKind;
  note?: string;
}

export interface LeverageAnalysis {
  pillars: { pillar: number; impact: number; helps: number[]; reason: string }[];
  actions: { cellId: string; impact: number; effort: number; helps: number[]; reason: string }[];
  /** 5-8 actions for this week: one per pillar where possible, synergies first. */
  picks: string[];
  insight: string;
}
