/** The input is invalid (e.g. a malformed identifier or out of range coordinates) */
export class ValidationError extends Error {
  override readonly name = "ValidationError";
}

/** The requested item does not exist in the navigation data */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

/** The request conflicts with the current state (e.g. a download is already in progress) */
export class ConflictError extends Error {
  override readonly name = "ConflictError";
}

/** The navigation data package could not be downloaded or installed (e.g. an expired URL) */
export class UpstreamError extends Error {
  override readonly name = "UpstreamError";
}
