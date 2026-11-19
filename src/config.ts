/** Client configuration and shared request helpers (transport-agnostic). */

import { ConfigurationError } from "./errors.js";
import { VERSION } from "./version.js";

/** Production API base URL. */
export const DEFAULT_BASE_URL = "https://tesseralytics.dev";

/** Environment variable consulted when no explicit API key is passed. */
export const API_KEY_ENV_VAR = "TESSERA_API_KEY";

/** Default `User-Agent` for requests made by this client. */
export const USER_AGENT = `tessera-typescript/${VERSION}`;

/** Statuses worth retrying: rate limiting + transient server/gateway errors. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Default per-request timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default retry count for transient failures. */
export const DEFAULT_MAX_RETRIES = 3;

/** Resolved configuration shared by every request the client makes. */
export interface ClientConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly userAgent: string;
}

/**
 * Resolve the API key from the argument, then `$TESSERA_API_KEY`.
 *
 * @throws {ConfigurationError} When no key can be resolved.
 */
export function resolveApiKey(apiKey?: string): string {
  const key = apiKey || process.env[API_KEY_ENV_VAR];
  if (!key) {
    throw new ConfigurationError(
      "No API key provided. Pass apiKey=... or set the " +
        `${API_KEY_ENV_VAR} environment variable. ` +
        "Get a free key at https://tesseralytics.dev.",
    );
  }
  return key;
}

/** Headers every request carries: bearer auth, user agent, JSON accept. */
export function authHeaders(config: ClientConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "User-Agent": config.userAgent,
    Accept: "application/json",
  };
}

/**
 * Compute the delay before a retry, in milliseconds.
 *
 * Honours a server `Retry-After` when present (and non-negative), otherwise
 * exponential backoff (0.5s, 1s, 2s, …) with full jitter to avoid thundering herds.
 */
export function backoffDelay(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null && retryAfter >= 0) return retryAfter * 1000;
  return Math.random() * 0.5 * 2 ** attempt * 1000;
}
