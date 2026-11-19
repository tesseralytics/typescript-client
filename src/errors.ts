/**
 * Error taxonomy for the Tessera client.
 *
 * Every error thrown by this library subclasses {@link TesseraError}, so a single
 * `catch (err) { if (err instanceof TesseraError) }` catches everything. API errors
 * additionally carry the HTTP `statusCode` and the machine-readable `code` returned
 * by the server (e.g. `not_found`, `forbidden`).
 */

/** Base class for every error thrown by `tessera-api`. */
export class TesseraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The client was misconfigured — e.g. no API key could be resolved. */
export class ConfigurationError extends TesseraError {}

/** An optional dependency (DuckDB, Apache Arrow) is required but absent. */
export class MissingDependencyError extends TesseraError {}

/** A network-level failure (connection/timeout) after exhausting retries. */
export class NetworkError extends TesseraError {}

/**
 * A presigned download URL expired before the read completed.
 *
 * Presigned URLs are short-lived (~15 minutes). Call {@link TesseraClient.toDuckDB} /
 * {@link TesseraClient.readArrow} again to mint fresh ones.
 */
export class PresignExpiredError extends TesseraError {}

/** The API returned an error response. */
export class TesseraAPIError extends TesseraError {
  /** HTTP status code of the response. */
  readonly statusCode: number;

  /** Machine-readable error code from the `{"error": ...}` body, or `null`. */
  readonly code: string | null;

  constructor(message: string, statusCode: number, code: string | null = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** 400 — the request was malformed (bad coin, month format, etc.). */
export class BadRequestError extends TesseraAPIError {}

/** 401 — the API key is missing, invalid, or revoked. */
export class AuthenticationError extends TesseraAPIError {}

/**
 * 403 — the request is not permitted for your account.
 *
 * The free key reaches every dataset and every market, so this is not a tier wall:
 * history outside the trailing window is purchased as a one-off bundle and refuses
 * with {@link NotFoundError} instead.
 */
export class ForbiddenError extends TesseraAPIError {}

/** 404 — the dataset, coin, or partition does not exist. */
export class NotFoundError extends TesseraAPIError {}

/** 500 — an unexpected server error. */
export class InternalServerError extends TesseraAPIError {}

/** 502/503/504 — the API is temporarily unavailable. Safe to retry. */
export class ServiceUnavailableError extends TesseraAPIError {}

/** Server error codes → error classes. */
const CODE_TO_ERROR: Record<string, typeof TesseraAPIError> = {
  bad_request: BadRequestError,
  unauthorized: AuthenticationError,
  forbidden: ForbiddenError,
  not_found: NotFoundError,
  unavailable: ServiceUnavailableError,
  internal: InternalServerError,
};

/** Status code → error class, used when the body carries no recognisable code. */
const STATUS_TO_ERROR: Record<number, typeof TesseraAPIError> = {
  400: BadRequestError,
  401: AuthenticationError,
  403: ForbiddenError,
  404: NotFoundError,
  500: InternalServerError,
  502: ServiceUnavailableError,
  503: ServiceUnavailableError,
  504: ServiceUnavailableError,
};

function errorCode(bodyText: string | null): string | null {
  if (!bodyText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (parsed !== null && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
    return parsed.error;
  }
  return null;
}

/**
 * Build the appropriate {@link TesseraAPIError} from an HTTP response.
 *
 * Prefers the `{"error": "<code>"}` body; falls back to the HTTP status.
 */
export function errorFromResponse(statusCode: number, bodyText: string | null): TesseraAPIError {
  const code = errorCode(bodyText);
  const ErrorClass =
    (code !== null ? CODE_TO_ERROR[code] : undefined) ??
    STATUS_TO_ERROR[statusCode] ??
    TesseraAPIError;
  const detail = code ? ` (${code})` : "";
  return new ErrorClass(
    `Tessera API request failed with HTTP ${statusCode}${detail}`,
    statusCode,
    code,
  );
}
