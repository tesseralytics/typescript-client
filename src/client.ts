/**
 * The async Tessera API client.
 *
 * Every network call goes through {@link TesseraClient.request}, which owns the retry
 * policy, the timeout, and error mapping; the public methods are thin endpoint wrappers.
 */

import type { DuckDBConnection } from "@duckdb/node-api";
import type { Table } from "apache-arrow";

import {
  buildUrl,
  datasetsRequest,
  downloadRequest,
  parseRetryAfter,
  partitionsRequest,
  shouldRetry,
  type PreparedRequest,
} from "./base.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  USER_AGENT,
  authHeaders,
  backoffDelay,
  resolveApiKey,
  type ClientConfig,
} from "./config.js";
import { NetworkError, TesseraError, errorFromResponse } from "./errors.js";
import {
  type Coins,
  type DatasetsResponse,
  type Download,
  type DayDownloadResponse,
  type DownloadResponse,
  type Months,
  type PartitionRef,
  type PartitionsResponse,
  downloadUrls,
  expandRefs,
} from "./models.js";
import { buildConnection, readArrowFromConnection, requireDuckDB } from "./readers/duckdb.js";
import { resolveRefs, type ResolvedPartition } from "./resolver.js";

/** Constructor options for {@link TesseraClient}. */
export interface TesseraClientOptions {
  /** API base URL. Defaults to the production endpoint. */
  baseUrl?: string;
  /** Per-request timeout, in milliseconds. */
  timeoutMs?: number;
  /** Retries for transient failures (429/5xx, network errors). */
  maxRetries?: number;
  /**
   * `fetch` implementation to use (advanced; defaults to the global `fetch`).
   * Injecting one bypasses nothing else — auth headers and retries still apply.
   */
  fetchImpl?: typeof fetch;
}

/** Options shared by the engine methods. */
export interface ReadOptions {
  /** Column subset to project, in order. Defaults to every column. */
  columns?: readonly string[];
}

/** Options for {@link TesseraClient.toDuckDB}. */
export interface DuckDBOptions extends ReadOptions {
  /** Reuse an existing connection instead of opening an in-memory one. */
  connection?: DuckDBConnection;
}

/**
 * Delay used between retries.
 *
 * `new Promise` rather than `Promise.withResolvers` (Node 22+): this package supports
 * Node 18. `setTimeout` stays global so fake timers can drive the retry loop.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

/** Runtime shape check for a download body (the wire is untrusted input). */
function asDownload(body: unknown): Download {
  if (body !== null && typeof body === "object") {
    if ("url" in body && typeof body.url === "string") return body as DownloadResponse;
    if ("days" in body && Array.isArray(body.days)) return body as DayDownloadResponse;
  }
  throw new TesseraError("download endpoint returned an unrecognised body");
}

/**
 * An async client for the Tessera API.
 *
 * @example
 * ```ts
 * const client = new TesseraClient();            // reads $TESSERA_API_KEY
 * const table = await client.readArrow("gold_ohlcv_1m", "BTC", "2025-09");
 * ```
 */
export class TesseraClient {
  /** Resolved configuration (API key included; do not log it). */
  readonly config: ClientConfig;

  readonly #fetch: typeof fetch;

  constructor(apiKey?: string, options: TesseraClientOptions = {}) {
    this.config = {
      apiKey: resolveApiKey(apiKey),
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      userAgent: USER_AGENT,
    };
    this.#fetch = options.fetchImpl ?? fetch;
  }

  // -- transport ---------------------------------------------------------
  async request(prepared: PreparedRequest): Promise<unknown> {
    const url = buildUrl(this.config.baseUrl, prepared);
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt >= this.config.maxRetries;
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: "GET",
          headers: authHeaders(this.config),
          // The download endpoint 302-redirects to the presigned URL; we want the JSON
          // body (with expiry), so never auto-follow.
          redirect: "manual",
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
      } catch (error) {
        if (last) {
          throw new NetworkError(
            `network error contacting Tessera: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        await sleep(backoffDelay(attempt, null));
        continue;
      }
      if (!last && shouldRetry(response.status)) {
        await sleep(backoffDelay(attempt, parseRetryAfter(response.headers)));
        continue;
      }
      if (response.ok) return response.json();
      throw errorFromResponse(response.status, await response.text());
    }
  }

  // -- metadata endpoints ------------------------------------------------
  /** List every dataset visible to your account. */
  async datasets(): Promise<DatasetsResponse> {
    const body = await this.request(datasetsRequest());
    return body as DatasetsResponse;
  }

  /** List the partitions of `asset`, optionally filtered by coin/month. */
  async partitions(
    asset: string,
    options: { coin?: string; month?: string } = {},
  ): Promise<PartitionsResponse> {
    const body = await this.request(partitionsRequest(asset, options.coin, options.month));
    return body as PartitionsResponse;
  }

  /**
   * Mint presigned download URLs for one partition.
   *
   * A finalised month returns a single-object {@link DownloadResponse}. The open month is
   * day-backed and returns a {@link DayDownloadResponse} carrying one URL per day object.
   */
  async downloadUrl(asset: string, coin: string, month: string): Promise<Download> {
    return asDownload(await this.request(downloadRequest(asset, coin, month)));
  }

  // -- partition helpers -------------------------------------------------
  /** Expand `(asset, coins, months)` into concrete partition references. */
  partitionRefs(asset: string, coins: Coins, months: Months): PartitionRef[] {
    return expandRefs(asset, coins, months);
  }

  #resolve(refs: readonly PartitionRef[]): Promise<ResolvedPartition[]> {
    return resolveRefs(
      async (ref) => downloadUrls(await this.downloadUrl(ref.asset, ref.coin, ref.month)),
      refs,
    );
  }

  async #parts(asset: string, coins: Coins, months: Months): Promise<ResolvedPartition[]> {
    return this.#resolve(this.partitionRefs(asset, coins, months));
  }

  // -- data loading ------------------------------------------------------
  /**
   * Open one or more partitions as a DuckDB connection carrying a `tessera` view.
   *
   * Query it with `SELECT ... FROM tessera`. When `options.connection` is supplied the
   * view is created on that connection and it is returned unchanged.
   *
   * @throws {MissingDependencyError} When `@duckdb/node-api` is not installed.
   */
  async toDuckDB(
    asset: string,
    coins: Coins,
    months: Months,
    options: DuckDBOptions = {},
  ): Promise<DuckDBConnection> {
    await requireDuckDB();
    return buildConnection(await this.#parts(asset, coins, months), options);
  }

  /**
   * Read one or more partitions into an Apache Arrow {@link Table}.
   *
   * @throws {MissingDependencyError} When `@duckdb/node-api` or `apache-arrow` is not
   * installed.
   */
  async readArrow(
    asset: string,
    coins: Coins,
    months: Months,
    options: ReadOptions = {},
  ): Promise<Table> {
    await requireDuckDB();
    const parts = await this.#parts(asset, coins, months);
    const connection = await buildConnection(parts);
    try {
      return await readArrowFromConnection(connection, options.columns);
    } finally {
      // The table is materialized, so the view is no longer needed.
      connection.closeSync();
    }
  }
}
