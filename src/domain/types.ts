// Shared by the server (API) and the client (store, UI).

export type GoalStatus = "active" | "achieved" | "archived";
export type CellKind = "task" | "habit";
/** How often a habit comes back. */
export type Repeat = "day" | "week" | "month";
export type CellStatus = "todo" | "doing" | "done";
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
  /** Habits only: every day, once a week or once a month. */
  repeat: Repeat;
  /** Weekday 0-6 (Sunday first) for a weekly habit, day of the month 1-31 for a monthly one. */
  repeatOn: number | null;
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
  text: string;
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
  /** Optional: copies saved on a device before Todoist existed lack it. */
  todoist?: TodoistInfo;
}

/** The Todoist connection as the account page shows it. */
export interface TodoistInfo {
  /** The server has a Todoist app set up, so the account page offers it. */
  available: boolean;
  connected: boolean;
  /** "reauth": Todoist wants a fresh sign-in. "project_gone": the Mandaala project was deleted or archived there. */
  status: "ok" | "reauth" | "project_gone" | null;
  /** The Todoist account's email. */
  email: string;
  lastSyncAt: string | null;
  /** The last thing that went wrong, in plain words ('' when fine). */
  error: string;
}

export interface AppState {
  user: Account;
  goals: GoalWithCells[];
  checkins: Checkin[];
}

export type CellPatch = Partial<
  Pick<
    Cell,
    | "text"
    | "notes"
    | "kind"
    | "repeat"
    | "repeatOn"
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
