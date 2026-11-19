/**
 * tessera-api — Hyperliquid datasets into DuckDB & Arrow over presigned Parquet.
 *
 * @example
 * ```ts
 * import { TesseraClient } from "tessera-api";
 *
 * const client = new TesseraClient();          // reads $TESSERA_API_KEY
 * const { partitions } = await client.partitions("gold_ohlcv_1m", { coin: "BTC" });
 * const latest = partitions.map((p) => p.month).sort().at(-1)!;
 * const table = await client.readArrow("gold_ohlcv_1m", "BTC", latest);
 * ```
 *
 * See https://tesseralytics.dev for an API key and the dataset reference.
 */

export {
  API_KEY_ENV_VAR,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  USER_AGENT,
  backoffDelay,
  resolveApiKey,
  type ClientConfig,
} from "./config.js";
export { VERSION } from "./version.js";

export {
  TesseraClient,
  type DuckDBOptions,
  type ReadOptions,
  type TesseraClientOptions,
} from "./client.js";

export {
  AuthenticationError,
  BadRequestError,
  ConfigurationError,
  ForbiddenError,
  InternalServerError,
  MissingDependencyError,
  NetworkError,
  NotFoundError,
  PresignExpiredError,
  ServiceUnavailableError,
  TesseraAPIError,
  TesseraError,
  errorFromResponse,
} from "./errors.js";

export {
  MONTH_REGEX,
  MonthSpan,
  downloadUrls,
  objectKey,
  partitionRef,
  validateMonth,
  type Coins,
  type DatasetSummary,
  type DatasetsResponse,
  type DayDownload,
  type DayDownloadResponse,
  type Download,
  type DownloadResponse,
  type ErrorBody,
  type MonthRange,
  type Months,
  type Partition,
  type PartitionRef,
  type PartitionsResponse,
} from "./models.js";
