import "server-only";
import { addDays } from "@/domain/days";
import { checkinsInPeriod, repeatOf } from "@/domain/repeat";
import {
  cellIdFrom,
  checkinMove,
  dueDay,
  dueTime,
  localDay,
  notesFrom,
  repeatString,
  routineDueDay,
  scheduleFromDue,
  todoistShape,
  weekEnd,
  type TodoistShape,
} from "@/domain/todoist";
import type { Cell, Checkin, GoalWithCells } from "@/domain/types";
import {
  deleteTodoistLink,
  deleteTodoistSection,
  dueTodoistOutbox,
  finishTodoistOutbox,
  listTodoistLinks,
  listTodoistSections,
  loadState,
  nextTodoistOutbox,
  queueTodoist,
  retryTodoistOutbox,
  saveTodoistLink,
  saveTodoistSection,
  updateCell,
  type LinkState,
  type OutboxRow,
  type TodoistAccountRow,
  type TodoistLink,
  type TodoistSection,
} from "@/server/repo";
import {
  commandId,
  TodoistError,
  type CommandStatus,
  type SyncCommand,
  type SyncResult,
  type TodoistDue,
  type TodoistProject,
  type TodoistSectionObject,
  type TodoistTask,
} from "./api";
import { PROJECT_NAME } from "./config";
import { withTodoist, type TodoistWorker } from "./session";

// Mandaala to Todoist. Every change to a square, a check-in or a goal queues a row in the outbox,
// in the same transaction as the change. A worker holding the account's lease reads the rows,
// compares each square with what Todoist was last sent (the link's `sent`) and sends only the
// difference as /sync commands. A command sent again keeps its id, so Todoist runs it once.

/** Rounds per call, so one worker never holds the lease for long. */
const ROUNDS = 5;
const ROWS_PER_ROUND = 200;
/** Todoist runs at most 100 commands per request... */
const COMMANDS_PER_REQUEST = 100;
/**
 * ...and reads at most 1 MiB, counted as sent: form-encoded UTF-8, where one Chinese character
 * takes 9 bytes. Requests stay well under.
 */
const BYTES_PER_REQUEST = 900_000;
/** The longest wait between tries while Todoist is down, in minutes. */
const MAX_BACKOFF_MIN = 60;
/** Check-ins that matter for a routine's day: a monthly period, with room. */
export const CHECKIN_DAYS = 62;

export const PROJECT_GONE = "The Mandaala project is gone from Todoist.";
export const DOWN = "Todoist is not answering right now. Mandaala will try again.";

/** What Todoist holds for a task never confirmed: nothing matches it, so everything is sent. */
const UNKNOWN: LinkState = {
  content: "",
  description: "",
  priority: 0,
  repeat: null,
  completed: false,
  activatedAt: null,
  due: null,
};

interface Square {
  goal: GoalWithCells;
  cell: Cell;
}

/** Everything one round works from, read at its start. */
interface Round {
  worker: TodoistWorker;
  rows: OutboxRow[];
  projectId: string;
  today: string;
  squares: Map<string, Square>;
  goals: Map<string, GoalWithCells>;
  checkins: Checkin[];
  links: Map<string, TodoistLink>;
  sections: Map<string, TodoistSection>;
  /** Square id: the oldest queued change that asked for it. */
  cells: Map<string, OutboxRow>;
  /** Goal id: the oldest change for the whole goal (the goal's own, or "all"). */
  goalRows: Map<string, OutboxRow>;
  /** A change Todoist refused for good, shown on the account page ('' when none). */
  error: string;
  /** Read from Todoist when needed, and dropped after every send, which may change them. */
  projectTasks: TodoistTask[] | null;
  todoistSections: TodoistSectionObject[] | null;
  alive: boolean | null;
}

interface Due {
  date: string;
  string?: string;
  lang: string;
}

/** One command, with what to remember once Todoist answered "ok" (`sentAt`: when it was sent). */
interface Step {
  command: SyncCommand;
  cellId?: string;
  goalId?: string;
  done?: (result: SyncResult, sentAt: number) => Promise<void>;
}

/** The project was deleted or archived in Todoist: everything waits for "Set it up again". */
class ProjectGone extends Error {}

/** Sends this account's queued Mandaala changes to Todoist. Cheap when nothing waits. Never throws. */
export async function drainTodoist(userId: string): Promise<void> {
  try {
    // This runs after every change a connected person makes: no lease unless something is due.
    const next = await nextTodoistOutbox(userId);
    if (next === null || next > Date.now()) return;
    // A worker already holding the lease goes on until the outbox is empty.
    await withTodoist(userId, pushQueued, { waitMs: 3000 });
  } catch (error) {
    console.error(error);
  }
}

/** One or more rounds of sending, for a caller that already holds the lease (catch-up, connect). */
export async function pushQueued(worker: TodoistWorker): Promise<void> {
  for (let round = 0; round < ROUNDS; round++) {
    if (round > 0) await worker.keepAlive();
    if (worker.account.status !== "ok") return;
    const rows = await dueTodoistOutbox(worker.userId, Date.now(), ROWS_PER_ROUND);
    if (!rows.length || !(await pushRows(worker, rows))) return;
  }
}

/** One round. False when the rest has to wait: Todoist is down, or the project is gone. */
async function pushRows(worker: TodoistWorker, rows: OutboxRow[]): Promise<boolean> {
  try {
    const round = await startRound(worker, rows);
    await send(round, await relink(round));
    await send(round, await sectionSteps(round));
    await send(round, await squareSteps(round));
    await archiveSections(round);
    await sendCheckins(round);
    await finishTodoistOutbox(worker.userId, rows.map((row) => row.id));
    await worker.update({ lastSyncAt: new Date().toISOString(), lastError: round.error });
    return true;
  } catch (error) {
    if (error instanceof ProjectGone) {
      await markProjectGone(worker);
      return false;
    }
    if (!(error instanceof TodoistError)) throw error;
    return failed(worker, rows, error);
  }
}

/** Todoist failed the round. What it may take later waits; what it refused for good is dropped. */
async function failed(worker: TodoistWorker, rows: OutboxRow[], error: TodoistError): Promise<boolean> {
  // Todoist wants a new sign-in: everything waits for it.
  if (worker.account.status !== "ok") return false;
  if (error.status === 404 && !(await projectAlive(worker))) {
    await markProjectGone(worker);
    return false;
  }
  const ids = rows.map((row) => row.id);
  if (busy(error)) {
    const attempts = Math.max(...rows.map((row) => row.attempts));
    const wait = error.retryAfter ?? Math.min(2 ** attempts, MAX_BACKOFF_MIN) * 60;
    await retryTodoistOutbox(worker.userId, ids, Date.now() + wait * 1000);
    await worker.update({ lastError: DOWN });
    return false;
  }
  await finishTodoistOutbox(worker.userId, ids);
  await worker.update({ lastError: refusal(error.message) });
  return true;
}

/** Worth trying again later: no answer, a refused token, too many requests, or Todoist's own trouble. */
function busy(error: TodoistError): boolean {
  return error.status === 0 || error.status === 401 || error.status === 429 || error.status >= 500;
}

function refusal(message: string): string {
  return `Todoist did not take a change (${message.replace(/\.$/, "")}).`;
}

// ---------- the project ----------

/** Today in the person's time zone. */
export function todayFor(account: TodoistAccountRow): string {
  return localDay(new Date(), account.timeZone || "UTC");
}

/**
 * The project everything goes in: the one stored, else the person's own one named Mandaala, else a
 * new one. The free plan limits projects: then the Inbox holds the sections instead.
 */
export async function ensureProject(worker: TodoistWorker): Promise<string> {
  if (worker.account.projectId) return worker.account.projectId;
  const read = await worker.api.sync({ syncToken: "*", resourceTypes: ["projects", "user"] });
  const found = read.projects?.find((project) => project.name === PROJECT_NAME && ownProject(project));
  const projectId = found?.id ?? (await addProject(worker, read.user?.inbox_project_id));
  await worker.update({ projectId });
  return projectId;
}

/**
 * Open, and the person's alone. A project shared with others, or in a team workspace, would show
 * their goals and notes to everyone in it, and let them change the person's chart.
 */
function ownProject(project: TodoistProject): boolean {
  if (project.is_deleted || project.is_archived || project.inbox_project) return false;
  return !project.shared && !project.workspace_id;
}

async function addProject(worker: TodoistWorker, inbox: string | undefined): Promise<string> {
  // A new id every time: a project whose answer was lost is found by its name on the next try.
  const command = { type: "project_add", uuid: crypto.randomUUID(), temp_id: crypto.randomUUID(), args: { name: PROJECT_NAME } };
  const result = await worker.api.sync({ commands: [command] });
  const status = result.sync_status?.[command.uuid];
  const projectId = result.temp_id_mapping?.[command.temp_id];
  if (status === "ok" && projectId) return projectId;
  const error = typeof status === "object" ? status : {};
  const limit = error.http_code === 403 || /MAX_PROJECTS|LIMIT/.test(error.error_tag ?? "");
  if (limit && inbox) return inbox;
  throw new TodoistError(error.http_code ?? 502, error.error ?? "Todoist did not make the Mandaala project.");
}

/** True while the project is still there and not archived. */
export async function projectAlive(worker: TodoistWorker): Promise<boolean> {
  const { projectId } = worker.account;
  if (!projectId) return true;
  const project = await worker.api.project(projectId);
  return Boolean(project && !project.is_deleted && !project.is_archived);
}

export async function markProjectGone(worker: TodoistWorker): Promise<void> {
  await worker.update({ status: "project_gone", lastError: PROJECT_GONE });
}

// ---------- what a round is about ----------

async function startRound(worker: TodoistWorker, rows: OutboxRow[]): Promise<Round> {
  const projectId = await ensureProject(worker);
  const today = todayFor(worker.account);
  const state = await loadState(worker.userId, addDays(today, -CHECKIN_DAYS));
  const links = await listTodoistLinks(worker.userId);
  const sections = await listTodoistSections(worker.userId);
  const round: Round = {
    worker,
    rows,
    projectId,
    today,
    squares: new Map(state.goals.flatMap((goal) => goal.cells.map((cell) => [cell.id, { goal, cell }] as const))),
    goals: new Map(state.goals.map((goal) => [goal.id, goal])),
    checkins: state.checkins,
    links: new Map(links.map((link) => [link.cellId, link])),
    sections: new Map(sections.map((section) => [section.goalId, section])),
    cells: new Map(),
    goalRows: new Map(),
    error: "",
    projectTasks: null,
    todoistSections: null,
    alive: null,
  };
  collectTargets(round);
  return round;
}

/** What the rows ask for: `all` every square in Todoist or linked, `goal` one goal's, `cell` one square. */
function collectTargets(round: Round): void {
  const take = (map: Map<string, OutboxRow>, key: string, row: OutboxRow) => {
    if (!map.has(key)) map.set(key, row);
  };
  for (const row of round.rows) {
    if (row.kind === "cell") take(round.cells, row.target, row);
    if (row.kind !== "goal" && row.kind !== "all") continue;
    // A deleted goal is only known by its section.
    const goalIds = row.kind === "all" ? [...round.goals.keys(), ...round.sections.keys()] : [row.target];
    for (const goalId of goalIds) {
      take(round.goalRows, goalId, row);
      for (const cell of round.goals.get(goalId)?.cells ?? []) {
        if (shapeOf(round, cell.id)) take(round.cells, cell.id, row);
      }
    }
    for (const link of round.links.values()) {
      if (row.kind === "all" || link.goalId === row.target) take(round.cells, link.cellId, row);
    }
  }
}

function shapeOf(round: Round, cellId: string): TodoistShape | null {
  const square = round.squares.get(cellId);
  return square ? todoistShape(square.goal, square.cell, round.worker.account.appUrl) : null;
}

/** The square belongs in Todoist and has no task there yet. */
function needsTask(round: Round, cellId: string): boolean {
  const shape = shapeOf(round, cellId);
  return Boolean(shape && !shape.completed && !round.links.get(cellId)?.taskId);
}

async function keepLink(round: Round, link: TodoistLink): Promise<void> {
  round.links.set(link.cellId, link);
  await saveTodoistLink(round.worker.userId, link);
}

async function forgetLink(round: Round, cellId: string): Promise<void> {
  round.links.delete(cellId);
  await deleteTodoistLink(round.worker.userId, cellId);
}

async function keepSection(round: Round, section: TodoistSection): Promise<void> {
  round.sections.set(section.goalId, section);
  await saveTodoistSection(round.worker.userId, section);
}

async function forgetSection(round: Round, goalId: string): Promise<void> {
  round.sections.delete(goalId);
  await deleteTodoistSection(round.worker.userId, goalId);
}

/** Todoist took a command for this square: remember what it holds now, and what we sent, with when. */
async function confirm(
  round: Round,
  cellId: string,
  change: Partial<LinkState>,
  echoes: [field: string, value: string][],
  sentAt: number,
): Promise<void> {
  const link = round.links.get(cellId);
  if (!link) return;
  link.sent = { ...(link.sent ?? UNKNOWN), ...change };
  link.version += 1;
  link.echoes = [...link.echoes, ...echoes.map(([field, value]) => ({ field, value, at: sentAt }))];
  await keepLink(round, link);
}

// ---------- tasks lost and found ----------

/** Our task for a square in the project, found by the square id in its footer link. */
async function findTask(round: Round, cellId: string): Promise<TodoistTask | undefined> {
  round.projectTasks ??= await round.worker.api.projectTasks(round.projectId);
  const linked = new Set([...round.links.values()].map((link) => link.taskId));
  return round.projectTasks.find(
    (task) => !linked.has(task.id) && cellIdFrom(task.description, round.worker.account.appUrl) === cellId,
  );
}

/**
 * A create whose answer was lost may have reached Todoist anyway, and after a disconnect the old
 * tasks are still there: link the task found by its footer instead of making another. Looked for
 * before every create, as a newer change to the square can be sent before the lost one is tried again.
 * A square done meanwhile is linked too, so its open task gets completed below. Returns the moves of
 * routines ticked meanwhile.
 */
async function relink(round: Round): Promise<Step[]> {
  const moves: Step[] = [];
  for (const cellId of round.cells.keys()) {
    const square = round.squares.get(cellId);
    const shape = shapeOf(round, cellId);
    if (!square || !shape || round.links.get(cellId)?.taskId) continue;
    const task = await findTask(round, cellId);
    if (!task) continue;
    // As Todoist has it: what differs from the square is sent below as an update. A p1 (4) is
    // always the person's own: it stays, as it would have if the link had never been lost.
    const link: TodoistLink = {
      cellId,
      goalId: square.goal.id,
      taskId: task.id,
      sent: {
        content: task.content,
        description: task.description,
        priority: task.priority === 4 ? shape.priority : task.priority,
        repeat: repeatIn(task, shape),
        completed: task.checked,
        activatedAt: square.cell.activatedAt,
        due: task.due?.date ?? null,
      },
      echoes: [],
      seenState: "",
      seenDone: "",
      inboundCheckin: null,
      version: 1,
      createdAt: new Date().toISOString(),
    };
    const move = shape.repeat && !shape.completed ? catchUpStep(round, square.cell, task, link) : null;
    if (move) {
      // Saved once Todoist took the move: when it did not, the next try finds the task again.
      round.links.set(cellId, link);
      moves.push(move);
    } else {
      await keepLink(round, link);
    }
  }
  return moves;
}

/**
 * A routine ticked in Mandaala while its task was not linked (disconnected, or the create's answer
 * lost) is behind in Todoist: its occurrence is completed there and moved on to Mandaala's next due
 * day, as the check-in would have done. Only for Todoist's repeat that is Mandaala's. A routine just
 * missed is left as it is, for the daily rollover.
 */
function catchUpStep(round: Round, cell: Cell, task: TodoistTask, link: TodoistLink): Step | null {
  if (!task.due || !sameSchedule(task.due, cell) || !checkinsInPeriod(cell, round.checkins, round.today).length) {
    return null;
  }
  const to = routineDueDay(cell, round.checkins, round.today, pickedDay(round, cell));
  if (dueDay(task.due.date) >= to) return null;
  const due = dueOn(task.due, to);
  return {
    command: taskCommand(round.worker.userId, link, "item_update_date_complete", { id: task.id, due, is_forward: 1 }),
    cellId: cell.id,
    done: (_result, sentAt) => confirm(round, cell.id, { due: due.date }, [["forward", to]], sentAt),
  };
}

/**
 * A task's repeat as the sync compares it, read the way a Todoist notice is: a repeat Mandaala can
 * show in our words (a time of day is kept by not sending it again), and one it cannot show as the
 * square's own, so it is never sent over.
 */
function repeatIn(task: TodoistTask, shape: TodoistShape): string | null {
  const schedule = scheduleFromDue(task.due);
  if (schedule === "custom") return shape.repeat;
  return schedule ? repeatString(schedule) : null;
}

// ---------- sections ----------

/** A section of the project with the goal's name that no other goal uses, kept for this goal. */
async function findSection(round: Round, goal: GoalWithCells): Promise<TodoistSection | undefined> {
  round.todoistSections ??= await round.worker.api.sections(round.projectId);
  const used = new Set([...round.sections.values()].map((section) => section.sectionId));
  const found = round.todoistSections.find(
    (section) => section.name === goal.title.trim() && !used.has(section.id) && !section.is_archived && !section.is_deleted,
  );
  if (!found) return undefined;
  const section = { goalId: goal.id, sectionId: found.id, name: found.name, archived: false };
  await keepSection(round, section);
  return section;
}

function sectionCommand(
  round: Round,
  goalId: string,
  type: string,
  row: OutboxRow,
  args: Record<string, unknown>,
): SyncCommand {
  // The queued change is part of the id: the same change sent again keeps it, and a later one (a
  // rename back, an archive after a restore) gets a new one.
  const uuid = commandId([round.worker.userId, goalId, type, row.id, JSON.stringify(args)].join(":"));
  return type === "section_add" ? { type, uuid, temp_id: commandId(`temp:${uuid}`), args } : { type, uuid, args };
}

/**
 * One section per goal, named after it, sent before the tasks that go in it. A goal getting a new
 * task needs its section: one found by name (after a reconnect), one brought back from the archive,
 * or a new one. A renamed goal renames its section.
 */
async function sectionSteps(round: Round): Promise<Step[]> {
  const needed = new Map<string, OutboxRow>();
  for (const [cellId, row] of round.cells) {
    const goalId = round.squares.get(cellId)?.goal.id;
    if (goalId && !needed.has(goalId) && needsTask(round, cellId)) needed.set(goalId, row);
  }
  const steps: Step[] = [];
  for (const [goalId, row] of new Map([...round.goalRows, ...needed])) {
    const goal = round.goals.get(goalId);
    if (goal?.status !== "active") continue;
    const adds = needed.has(goalId);
    const section = round.sections.get(goalId) ?? (adds ? await findSection(round, goal) : undefined);
    if (!section) {
      if (adds) steps.push(addSection(round, goal, row));
      continue;
    }
    const { sectionId } = section;
    if (section.archived && adds) {
      steps.push(sectionStep(round, goalId, sectionCommand(round, goalId, "section_unarchive", row, { id: sectionId }), { archived: false }));
    }
    const name = goal.title.trim();
    if (section.name !== name && (adds || !section.archived)) {
      steps.push(sectionStep(round, goalId, sectionCommand(round, goalId, "section_update", row, { id: sectionId, name }), { name }));
    }
  }
  return steps;
}

function sectionStep(round: Round, goalId: string, command: SyncCommand, change: Partial<TodoistSection>): Step {
  return {
    command,
    goalId,
    async done() {
      const section = round.sections.get(goalId);
      if (section) await keepSection(round, { ...section, ...change });
    },
  };
}

function addSection(round: Round, goal: GoalWithCells, row: OutboxRow): Step {
  const name = goal.title.trim();
  const command = sectionCommand(round, goal.id, "section_add", row, { name, project_id: round.projectId });
  return {
    command,
    goalId: goal.id,
    async done(result) {
      // No id comes back when Todoist skipped a command it had run before: find that section by name.
      const sectionId = result.temp_id_mapping?.[command.temp_id!] ?? (await findSection(round, goal))?.sectionId;
      if (sectionId) await keepSection(round, { goalId: goal.id, sectionId, name, archived: false });
      else await queueTodoist(round.worker.userId, "goal", goal.id);
    },
  };
}

/**
 * A goal that left (achieved, archived or deleted) had its open tasks deleted by now. Its section is
 * archived only when nothing is left open in it: Todoist completes the open tasks of a section it
 * archives, and the person may keep tasks of their own there. Never deleted, for the same reason.
 */
async function archiveSections(round: Round): Promise<void> {
  const leaving: [TodoistSection, OutboxRow][] = [];
  for (const [goalId, row] of round.goalRows) {
    const section = round.sections.get(goalId);
    const goal = round.goals.get(goalId);
    if (!section || goal?.status === "active") continue;
    if (!section.archived) leaving.push([section, row]);
    else if (!goal) await forgetSection(round, goalId);
  }
  if (!leaving.length) return;
  const open = new Set((await round.worker.api.projectTasks(round.projectId)).map((task) => task.section_id));
  const steps: Step[] = [];
  for (const [section, row] of leaving) {
    const deleted = !round.goals.has(section.goalId);
    if (open.has(section.sectionId)) {
      if (deleted) await forgetSection(round, section.goalId);
      continue;
    }
    steps.push({
      command: sectionCommand(round, section.goalId, "section_archive", row, { id: section.sectionId }),
      goalId: section.goalId,
      done: () => (deleted ? forgetSection(round, section.goalId) : keepSection(round, { ...section, archived: true })),
    });
  }
  await send(round, steps);
}

// ---------- tasks ----------

/**
 * A command on a linked task. The link's version is part of its id: the same change sent again keeps
 * it, the next change gets a new one. So is the link's creation, as a link made again for the same
 * task starts counting again.
 */
export function taskCommand(userId: string, link: TodoistLink, type: string, args: Record<string, unknown>): SyncCommand {
  const seed = [userId, link.cellId, type, link.createdAt, link.version, JSON.stringify(args)].join(":");
  return { type, uuid: commandId(seed), args };
}

/** The local day the square was picked for this week, or null. */
function pickedDay(round: Round, cell: Cell): string | null {
  return cell.activatedAt ? localDay(cell.activatedAt, round.worker.account.timeZone || "UTC") : null;
}

/** The routine's repeat with the day it is due on now. To verify on a real account: Todoist keeps a date sent with a repeating string. */
function routineDue(round: Round, cell: Cell, repeat: string): Due {
  return { string: repeat, date: routineDueDay(cell, round.checkins, round.today, pickedDay(round, cell)), lang: "en" };
}

/** A task is due at the end of the week it is in. Always English: the person's Todoist may not be. */
function taskDue(round: Round): Due {
  return { date: weekEnd(round.today, round.worker.account.weekStart), lang: "en" };
}

/** A Todoist due moved to another day, keeping its wording, language and time of day. */
function dueOn(due: TodoistDue, day: string): Due {
  return { date: day + dueTime(due.date), string: due.string, lang: due.lang ?? "en" };
}

/** The commands that bring each asked-for square's task in line with the square. */
async function squareSteps(round: Round): Promise<Step[]> {
  const steps: Step[] = [];
  for (const [cellId, row] of round.cells) {
    const square = round.squares.get(cellId);
    const shape = shapeOf(round, cellId);
    const link = round.links.get(cellId);
    if (!square || !shape) {
      if (link) steps.push(...(await removeSteps(round, link)));
    } else if (!link?.taskId) {
      if (!shape.completed) steps.push(...addSteps(round, square, shape, row));
    } else {
      steps.push(...updateSteps(round, square, shape, link));
    }
  }
  return steps;
}

/**
 * The square left Todoist's list: its open task goes; a completed one stays there, unlinked. One
 * done in Mandaala is completed there first when that was not sent yet, so it is never deleted.
 */
async function removeSteps(round: Round, link: TodoistLink): Promise<Step[]> {
  if (!link.taskId || link.sent?.completed) {
    await forgetLink(round, link.cellId);
    return [];
  }
  const cell = round.squares.get(link.cellId)?.cell;
  const command =
    cell?.status === "done"
      ? taskCommand(round.worker.userId, link, "item_complete", completeArgs(link, cell))
      : taskCommand(round.worker.userId, link, "item_delete", { id: link.taskId });
  return [{ command, cellId: link.cellId, done: () => forgetLink(round, link.cellId) }];
}

/** A new task in the goal's section: a task due at the end of this week, a routine on its day. */
function addSteps(round: Round, { goal, cell }: Square, shape: TodoistShape, row: OutboxRow): Step[] {
  const section = round.sections.get(goal.id);
  // The section could not be made this round; why is on the account page.
  if (!section || section.archived) return [];
  const due = shape.repeat ? routineDue(round, cell, shape.repeat) : taskDue(round);
  const args = {
    content: shape.content,
    description: shape.description,
    priority: shape.priority,
    project_id: round.projectId,
    section_id: section.sectionId,
    due,
  };
  // One id per queued change, whatever the date: sent again after a lost answer, even the next
  // day, it is the same command and Todoist runs it once.
  const uuid = commandId([round.worker.userId, cell.id, "item_add", row.id].join(":"));
  const command = { type: "item_add", uuid, temp_id: commandId(`temp:${uuid}`), args };
  const done = async (result: SyncResult) => {
    // No id comes back when Todoist skipped a command it had run before: find the task it made.
    const taskId = result.temp_id_mapping?.[command.temp_id] ?? (await findTask(round, cell.id))?.id;
    if (!taskId) return;
    const { content, description, priority, repeat } = shape;
    await keepLink(round, {
      cellId: cell.id,
      goalId: goal.id,
      taskId,
      sent: { content, description, priority, repeat, completed: false, activatedAt: cell.activatedAt, due: due.date },
      echoes: [],
      seenState: "",
      seenDone: "",
      inboundCheckin: null,
      version: 1,
      createdAt: new Date().toISOString(),
    });
  };
  return [{ command, cellId: cell.id, goalId: goal.id, done }];
}

/** Only what changed since Todoist was last sent the square. */
function updateSteps(round: Round, { cell }: Square, shape: TodoistShape, link: TodoistLink): Step[] {
  const sent = link.sent ?? UNKNOWN;
  const fields: Record<string, unknown> = {};
  if (shape.content !== sent.content) fields.content = shape.content;
  if (shape.description !== sent.description) fields.description = shape.description;
  if (shape.priority !== sent.priority) fields.priority = shape.priority;
  const reopened = sent.completed && !shape.completed;
  const due = dueChange(round, cell, shape, sent, reopened);
  if (due) fields.due = due;
  const update = Object.keys(fields).length ? [updateStep(round, link, cell, shape, fields)] : [];
  if (shape.completed && !sent.completed) return [...update, completeStep(round, link, cell)];
  // Reopened first: the new due date belongs to the task as it is again.
  if (reopened) return [uncompleteStep(round, link), ...update];
  return update;
}

/** A new due date: the repeat changed, a task was picked again, or the square was reopened. */
function dueChange(round: Round, cell: Cell, shape: TodoistShape, sent: LinkState, reopened: boolean): Due | null {
  if (shape.repeat !== sent.repeat) return shape.repeat ? routineDue(round, cell, shape.repeat) : taskDue(round);
  if (shape.completed) return null;
  if (shape.repeat) return reopened ? routineDue(round, cell, shape.repeat) : null;
  const pickedAgain = cell.activatedAt !== sent.activatedAt;
  const late = reopened && sent.due !== null && dueDay(sent.due) < round.today;
  return pickedAgain || late ? taskDue(round) : null;
}

function updateStep(round: Round, link: TodoistLink, cell: Cell, shape: TodoistShape, fields: Record<string, unknown>): Step {
  return {
    command: taskCommand(round.worker.userId, link, "item_update", { id: link.taskId, ...fields }),
    cellId: link.cellId,
    done: (_result, sentAt) => {
      const change: Partial<LinkState> = { activatedAt: cell.activatedAt };
      const echoes: [string, string][] = [];
      if ("content" in fields) {
        change.content = shape.content;
        echoes.push(["content", shape.content]);
      }
      if ("description" in fields) {
        change.description = shape.description;
        echoes.push(["notes", notesFrom(shape.description, round.worker.account.appUrl)]);
      }
      if ("priority" in fields) change.priority = shape.priority;
      const due = fields.due as Due | undefined;
      if (due) {
        change.due = due.date;
        change.repeat = shape.repeat;
        echoes.push(["repeat", shape.repeat ?? ""], ["due", due.date]);
      }
      return confirm(round, link.cellId, change, echoes, sentAt);
    },
  };
}

/** Completed when Mandaala says it was done, not when the change arrived. */
function completeArgs(link: TodoistLink, cell: Cell): Record<string, unknown> {
  return cell.doneAt ? { id: link.taskId, date_completed: cell.doneAt } : { id: link.taskId };
}

/** Done in Mandaala: a task is completed, a routine done for good archives its repeating task. */
function completeStep(round: Round, link: TodoistLink, cell: Cell): Step {
  return {
    command: taskCommand(round.worker.userId, link, "item_complete", completeArgs(link, cell)),
    cellId: link.cellId,
    done: (_result, sentAt) => confirm(round, link.cellId, { completed: true }, [["done", cell.doneAt ?? ""]], sentAt),
  };
}

function uncompleteStep(round: Round, link: TodoistLink): Step {
  return {
    command: taskCommand(round.worker.userId, link, "item_uncomplete", { id: link.taskId }),
    cellId: link.cellId,
    done: (_result, sentAt) => confirm(round, link.cellId, { completed: false }, [["undone", ""]], sentAt),
  };
}

// ---------- check-ins ----------

/** A routine's Todoist task repeats the way Mandaala's does (not a repeat the person set there). */
function sameSchedule(due: TodoistTask["due"], cell: Cell): boolean {
  const schedule = scheduleFromDue(due);
  if (!schedule || schedule === "custom") return false;
  const ours = repeatOf(cell);
  return schedule.repeat === ours.repeat && (ours.repeat === "day" || schedule.repeatOn === ours.on);
}

function checkinOf(row: OutboxRow): { day: string; done: boolean } | null {
  try {
    const value: unknown = JSON.parse(row.detail);
    const { day, done } = (value ?? {}) as { day?: unknown; done?: unknown };
    return typeof day === "string" && typeof done === "boolean" ? { day, done } : null;
  } catch {
    return null;
  }
}

/**
 * Check-ins made in Mandaala move the routine's occurrence in Todoist, in the order they were made.
 * Only a check-in in the period it was made in moves it; fixing older days stays in Mandaala.
 */
async function sendCheckins(round: Round): Promise<void> {
  const rows = round.rows.filter((row) => {
    const link = round.links.get(row.target);
    return row.kind === "checkin" && link?.taskId && round.squares.get(row.target)?.cell.kind === "habit";
  });
  if (!rows.length) return;
  const ids = rows.map((row) => round.links.get(row.target)!.taskId!);
  // Completed and deleted tasks are missing here: nothing to move.
  const tasks = new Map((await round.worker.api.tasks(ids)).map((task) => [task.id, task]));
  const steps: Step[] = [];
  for (const row of rows) {
    const step = await checkinStep(round, row, tasks);
    if (step) steps.push(step);
  }
  await send(round, steps);
}

async function checkinStep(round: Round, row: OutboxRow, tasks: Map<string, TodoistTask>): Promise<Step | null> {
  const checkin = checkinOf(row);
  const { cell } = round.squares.get(row.target)!;
  const link = round.links.get(row.target)!;
  const task = tasks.get(link.taskId!);
  if (!checkin || !task?.due?.is_recurring) return null;
  if (link.inboundCheckin?.day === checkin.day) {
    // The person changed in Mandaala a day a Todoist tick had made: an undo there must not touch it.
    link.inboundCheckin = null;
    await keepLink(round, link);
  }
  // The period is the one the check-in was made in: sent late (Todoist was down overnight), it
  // still moves the occurrence on.
  const madeOn = localDay(row.createdAt, round.worker.account.timeZone || "UTC");
  const move = checkinMove(cell, round.checkins, checkin.day, checkin.done, dueDay(task.due.date), madeOn);
  if (!move) return null;
  const same = sameSchedule(task.due, cell);
  // A repeat the person set in Todoist: a tick moves it on by Todoist's own rule, an untick is theirs.
  if (!same && !move.forward) return null;
  // Picked after that period's due day: Todoist's occurrence was never on it.
  const picked = pickedDay(round, cell);
  if (!move.forward && repeatOf(cell).repeat !== "day" && picked && picked > move.to) return null;
  const due = dueOn(task.due, move.to);
  // The next check-in of this square sees where the occurrence is now.
  task.due = { ...task.due, date: due.date };
  const uuid = commandId(`checkin:${row.id}`);
  const command = same
    ? { type: "item_update_date_complete", uuid, args: { id: task.id, due, is_forward: move.forward ? 1 : 0 } }
    : { type: "item_close", uuid, args: { id: task.id } };
  const echo: [string, string] = [move.forward ? "forward" : "back", move.to];
  return { command, cellId: cell.id, done: (_result, sentAt) => confirm(round, cell.id, { due: due.date }, [echo], sentAt) };
}

// ---------- sending ----------

/** Requests Todoist takes: at most 100 commands, and well under its size limit. */
function chunks(steps: Step[]): Step[][] {
  const all: Step[][] = [];
  let chunk: Step[] = [];
  let size = 0;
  for (const step of steps) {
    const bytes = bodyBytes(step.command);
    if (chunk.length && (chunk.length === COMMANDS_PER_REQUEST || size + bytes > BYTES_PER_REQUEST)) {
      all.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(step);
    size += bytes;
  }
  if (chunk.length) all.push(chunk);
  return all;
}

/**
 * The body a command would make sent alone, form-encoded as api.ts sends it. A request with several
 * is never bigger than the sum of theirs.
 */
function bodyBytes(command: SyncCommand): number {
  return Buffer.byteLength(new URLSearchParams({ commands: JSON.stringify([command]) }).toString());
}

/** Sends the steps in order and handles every answer. Throws what stops the round. */
async function send(round: Round, steps: Step[]): Promise<void> {
  for (const chunk of chunks(steps)) {
    await round.worker.keepAlive();
    const sentAt = Date.now();
    const result = await round.worker.api.sync({ commands: chunk.map((step) => step.command) });
    // What was read from Todoist before this may have changed.
    round.projectTasks = null;
    round.todoistSections = null;
    const stops: Error[] = [];
    for (const step of chunk) {
      const status = result.sync_status?.[step.command.uuid];
      if (status === "ok") {
        await step.done?.(result, sentAt);
        continue;
      }
      const stop = await refused(round, step, status);
      if (stop) stops.push(stop);
    }
    const stop = stops.find((error) => error instanceof ProjectGone) ?? stops[0];
    if (stop) throw stop;
  }
}

/** Handles a command Todoist refused. Returns what stops the round, if anything. */
async function refused(round: Round, step: Step, status: CommandStatus | undefined): Promise<Error | null> {
  const error = typeof status === "object" ? status : null;
  const tag = error?.error_tag ?? "";
  const code = error?.http_code ?? 0;
  if (tag === "PROJECT_NOT_FOUND") return new ProjectGone();
  if (tag === "SECTION_NOT_FOUND" && step.goalId) {
    // The person deleted the section: make it again.
    await forgetSection(round, step.goalId);
    await queueTodoist(round.worker.userId, "goal", step.goalId);
    return null;
  }
  if (step.cellId && (tag === "ITEM_NOT_FOUND" || (code === 404 && !tag))) return taskGone(round, step.cellId);
  if (!error || code === 429 || code >= 500) {
    const wait = error?.error_extra?.retry_after;
    return new TodoistError(code || 502, error?.error ?? "Todoist did not answer a change.", typeof wait === "number" ? wait : null);
  }
  // Todoist takes nothing new in a project archived there, and the notice of that may be lost.
  round.alive ??= await projectAlive(round.worker);
  if (!round.alive) return new ProjectGone();
  round.error ||= refusal(error.error ?? tag);
  return null;
}

/**
 * Todoist has no such task: the person deleted it there before our change arrived. Unless the
 * whole project is gone, the square leaves this week, as when Todoist's notice comes first. A
 * square that is leaving Todoist's list anyway (taken out, its goal archived) only lets go of it.
 */
async function taskGone(round: Round, cellId: string): Promise<Error | null> {
  if (!round.links.has(cellId)) return null;
  if (shapeOf(round, cellId)) {
    round.alive ??= await projectAlive(round.worker);
    if (!round.alive) return new ProjectGone();
    await updateCell(round.worker.userId, cellId, { active: false }, { fromTodoist: true });
  }
  await forgetLink(round, cellId);
  return null;
}
