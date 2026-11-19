/**
 * Transport-agnostic plumbing: URL construction, retry decisions, header parsing.
 *
 * Everything here is pure — no I/O — so the retry policy and URL shape stay testable
 * without a server.
 */

import { RETRYABLE_STATUSES } from "./config.js";

/** URL-encode a single path segment (no slashes survive). */
export function seg(value: string): string {
  return encodeURIComponent(value);
}

/** A resolved HTTP request: path + ordered query params, ready to send. */
export interface PreparedRequest {
  readonly path: string;
  readonly params: readonly (readonly [string, string])[];
}

export function datasetsRequest(): PreparedRequest {
  return { path: "/v1/datasets", params: [] };
}

export function partitionsRequest(
  asset: string,
  coin?: string,
  month?: string,
): PreparedRequest {
  const params: [string, string][] = [];
  if (coin !== undefined) params.push(["coin", coin]);
  if (month !== undefined) params.push(["month", month]);
  return { path: `/v1/datasets/${seg(asset)}`, params };
}

export function downloadRequest(asset: string, coin: string, month: string): PreparedRequest {
  return {
    path: `/v1/datasets/${seg(asset)}/${seg(coin)}/${seg(month)}/download`,
    params: [],
  };
}

/** Join a base URL and a prepared request into an absolute URL. */
export function buildUrl(baseUrl: string, prepared: PreparedRequest): string {
  const url = `${baseUrl}${prepared.path}`;
  if (prepared.params.length === 0) return url;
  const search = new URLSearchParams();
  for (const [key, value] of prepared.params) search.append(key, value);
  return `${url}?${search.toString()}`;
}

/** Whether a status code is worth retrying. */
export function shouldRetry(statusCode: number): boolean {
  return RETRYABLE_STATUSES.has(statusCode);
}

/** Parse the `Retry-After` header (seconds form only) if present. */
export function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number.parseFloat(raw);
  return Number.isNaN(seconds) ? null : seconds;
}
