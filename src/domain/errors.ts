/** An error with an HTTP status, shown to the user as a short JSON message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The server's answer when the session belongs to another account than the page's header names. */
export const OTHER_ACCOUNT = "This page belongs to another account.";
