import "server-only";

// Todoist's addresses, and the app registered in its App Management Console.

export const TODOIST_API = "https://api.todoist.com/api/v1";
export const TODOIST_AUTHORIZE_URL = "https://app.todoist.com/oauth/authorize";
export const TODOIST_TOKEN_URL = "https://api.todoist.com/oauth/access_token";
/** Read and change tasks, projects and sections, and delete tasks. */
export const TODOIST_SCOPES = "data:read_write,data:delete";
/** The Todoist project that holds everything Mandaala sends. */
export const PROJECT_NAME = "Mandaala";

/** The registered Todoist app (TODOIST_CLIENT_ID / TODOIST_CLIENT_SECRET), or null when not set up. */
export function todoistApp(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.TODOIST_CLIENT_ID?.trim();
  const clientSecret = process.env.TODOIST_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function todoistAvailable(): boolean {
  return todoistApp() !== null;
}
