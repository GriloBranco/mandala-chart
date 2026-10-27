// All reads and writes of goals, squares, reports, events and the Todoist sync. Route handlers
// import from here.
//
// Every function takes the signed-in user's id first and only reads or writes that user's
// rows: goals, reports, events and check-ins by user_id, squares through their goal. Anything
// that belongs to someone else behaves exactly as if it did not exist (404, or skipped).
// New rows are written only while what they belong to still exists (the account, the goal, the
// report), checked inside the same write transaction: a request that passed the session check
// just before its account or goal was deleted leaves nothing behind. The few Todoist lookups
// that cannot know the user yet (webhooks, the daily job) say so where they are defined.

export { createGoal, deleteGoal, getGoal, listActiveGoals, loadState, updateGoal } from "./goals";
export { getCell, setCheckin, updateCell, updateCells } from "./cells";
export { deleteReport, listEvents, listReports, saveReport } from "./reports";
export { exportData } from "./account";
export {
  cellOutboxStatement,
  checkinOutboxStatement,
  claimTodoistLease,
  deleteTodoistData,
  deleteTodoistLink,
  deleteTodoistSection,
  dueTodoistOutbox,
  findTodoistOwner,
  finishTodoistOutbox,
  getTodoistAccount,
  goalOutboxStatement,
  listTodoistLinks,
  listTodoistSections,
  LONG_ECHOES,
  nextTodoistOutbox,
  queueTodoist,
  recordTodoistDelivery,
  releaseTodoistLease,
  releaseTodoistOutbox,
  retryTodoistOutbox,
  saveTodoistAccount,
  saveTodoistLink,
  saveTodoistSection,
  sweepTodoistDeliveries,
  todoistDeliverySeen,
  todoistLinkForTask,
  todoistUserIds,
  updateTodoistAccount,
} from "./todoist";
export type {
  Echo,
  LinkState,
  OutboxRow,
  TodoistAccountRow,
  TodoistLink,
  TodoistSection,
  TodoistStatus,
} from "./todoist";
