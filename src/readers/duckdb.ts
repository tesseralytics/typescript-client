/**
 * Load Tessera partitions into DuckDB.
 *
 * Uses DuckDB's `httpfs` to range-read the presigned Parquet directly; the returned
 * connection carries a `tessera` view that can be filtered and aggregated in SQL with
 * predicate pushdown.
 */

import type * as Arrow from "apache-arrow";
import type { Table } from "apache-arrow";
import type * as DuckDB from "@duckdb/node-api";
import type {
  DuckDBConnection,
  DuckDBListLogicalType,
  DuckDBLogicalType,
} from "@duckdb/node-api";

import {
  MissingDependencyError,
  NetworkError,
  PresignExpiredError,
  TesseraError,
} from "../errors.js";
import type { ResolvedPartition } from "../resolver.js";

/** Substrings of a DuckDB error that mean "the presigned URL was rejected". */
const PRESIGN_MARKERS = [
  "http 403",
  "403 forbidden",
  "expired",
  "accessdenied",
  "access denied",
  "forbidden",
] as const;

/** Column names accepted from callers; anything outside this shape is refused. */
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type DuckDBModule = typeof DuckDB;

let duckdbModule: DuckDBModule | undefined;
let arrowModule: typeof Arrow | undefined;

/**
 * Import `@duckdb/node-api`, or raise a helpful error.
 *
 * @throws {MissingDependencyError} When the optional peer dependency is absent.
 */
export async function requireDuckDB(): Promise<DuckDBModule> {
  if (duckdbModule !== undefined) return duckdbModule;
  // Dynamic on purpose: the peer dependency is optional, so a static import would make
  // the whole package fail to load for users who never touch the DuckDB engine.
  try {
    duckdbModule = await import("@duckdb/node-api");
  } catch (error) {
    throw new MissingDependencyError(
      "'@duckdb/node-api' is required for this feature. " +
        "Install it with: npm install @duckdb/node-api",
      { cause: error },
    );
  }
  return duckdbModule;
}

/**
 * Import `apache-arrow`, or raise a helpful error.
 *
 * @throws {MissingDependencyError} When the optional peer dependency is absent.
 */
export async function requireArrow(): Promise<typeof Arrow> {
  if (arrowModule !== undefined) return arrowModule;
  // Dynamic for the same reason as `requireDuckDB`: the peer is optional.
  try {
    arrowModule = await import("apache-arrow");
  } catch (error) {
    throw new MissingDependencyError(
      "'apache-arrow' is required for this feature. Install it with: npm install apache-arrow",
      { cause: error },
    );
  }
  return arrowModule;
}

/** Quote a value as a SQL string literal. */
export function sqlStr(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** One Parquet path, or a DuckDB list literal of paths for a day-backed partition. */
export function sqlUrlList(urls: readonly string[]): string {
  if (urls.length === 1) return sqlStr(urls[0] as string);
  return `[${urls.map(sqlStr).join(", ")}]`;
}

/** Translate a DuckDB failure into the client's error taxonomy. */
export function toReaderError(error: unknown): Error {
  if (error instanceof TesseraError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (PRESIGN_MARKERS.some((marker) => lower.includes(marker))) {
    return new PresignExpiredError(
      "A presigned download URL was rejected (likely expired). Presigned URLs are " +
        "short-lived — call toDuckDB()/readArrow() again to mint fresh ones.",
      { cause: error },
    );
  }
  return new NetworkError(message, { cause: error });
}

function projectionSql(columns?: readonly string[]): string {
  if (columns === undefined || columns.length === 0) return "*";
  for (const column of columns) {
    if (!COLUMN_RE.test(column)) {
      throw new TesseraError(`invalid column name: '${column}'`);
    }
  }
  return columns.join(", ");
}

/**
 * Build a connection carrying a `tessera` view over the resolved partitions.
 *
 * A day-backed partition (the open month) reads all of its day objects as one leaf. For
 * multi-partition reads each leaf is unioned with a `month` column identifying the source
 * partition; `coin` is a native Parquet column in every dataset. Query it with
 * `SELECT ... FROM tessera`.
 *
 * The returned connection is the caller's to close (`connection.closeSync()`), unless it
 * was supplied in `options.connection`, in which case it is returned unchanged.
 *
 * @throws {NetworkError} When the connection or view creation fails.
 * @throws {PresignExpiredError} When DuckDB reports a rejected/expired URL.
 */
export async function buildConnection(
  parts: readonly ResolvedPartition[],
  options: { connection?: DuckDBConnection; columns?: readonly string[] } = {},
): Promise<DuckDBConnection> {
  const duckdb = await requireDuckDB();
  const selectColumns = projectionSql(options.columns);
  const multi = parts.length > 1;

  const selects = parts.map(({ ref, urls }) => {
    // `coin` already exists in every Parquet leaf. Appending another `coin` alias makes
    // DuckDB silently rename it to `coin_1`, so only `month` is injected.
    const projection = multi
      ? `${selectColumns}, ${sqlStr(ref.month)} AS month`
      : selectColumns;
    return `SELECT ${projection} FROM read_parquet(${sqlUrlList(urls)})`;
  });
  const query = selects.join("\nUNION ALL\n");

  let connection: DuckDBConnection;
  try {
    connection = options.connection ?? (await duckdb.DuckDBConnection.create());
  } catch (error) {
    throw toReaderError(error);
  }

  try {
    // Recent DuckDB autoloads httpfs for https paths; load explicitly but don't fail if
    // the environment can't reach the extension repository.
    await connection.run("INSTALL httpfs; LOAD httpfs;").catch(() => undefined);
    await connection.run(`CREATE OR REPLACE TEMP VIEW tessera AS ${query}`);
  } catch (error) {
    if (options.connection === undefined) connection.closeSync();
    throw toReaderError(error);
  }
  return connection;
}

/**
 * Map one DuckDB logical type onto the Arrow type the vectors are built with.
 *
 * DuckDB hands back JS values that Apache Arrow's builders understand — `Date` for
 * timestamps, `bigint` for 64-bit integers and times, arrays for lists — so the mapping is
 * purely a type declaration. Types with no faithful Arrow builder (DECIMAL, HUGEINT,
 * STRUCT, MAP, …) are refused rather than silently coerced.
 */
function arrowTypeFor(
  duckdb: DuckDBModule,
  arrow: typeof Arrow,
  logical: DuckDBLogicalType,
): Arrow.DataType {
  const ids = duckdb.DuckDBTypeId;
  switch (logical.typeId) {
    case ids.BOOLEAN:
      return new arrow.Bool();
    case ids.TINYINT:
      return new arrow.Int8();
    case ids.SMALLINT:
      return new arrow.Int16();
    case ids.INTEGER:
      return new arrow.Int32();
    case ids.BIGINT:
      return new arrow.Int64();
    case ids.UTINYINT:
      return new arrow.Uint8();
    case ids.USMALLINT:
      return new arrow.Uint16();
    case ids.UINTEGER:
      return new arrow.Uint32();
    case ids.UBIGINT:
      return new arrow.Uint64();
    case ids.FLOAT:
      return new arrow.Float32();
    case ids.DOUBLE:
      return new arrow.Float64();
    case ids.VARCHAR:
    case ids.ENUM:
    case ids.UUID:
      return new arrow.Utf8();
    case ids.TIMESTAMP:
      return new arrow.TimestampMicrosecond();
    case ids.TIMESTAMP_S:
      return new arrow.TimestampSecond();
    case ids.TIMESTAMP_MS:
      return new arrow.TimestampMillisecond();
    case ids.TIMESTAMP_NS:
      return new arrow.TimestampNanosecond();
    case ids.TIMESTAMP_TZ:
      return new arrow.TimestampMicrosecond("UTC");
    case ids.DATE:
      return new arrow.DateDay();
    case ids.TIME:
      return new arrow.TimeMicrosecond();
    case ids.TIME_NS:
      return new arrow.TimeNanosecond();
    case ids.SQLNULL:
      return new arrow.Null();
    case ids.LIST: {
      const valueType = (logical as DuckDBListLogicalType).valueType;
      return new arrow.List(new arrow.Field("item", arrowTypeFor(duckdb, arrow, valueType), true));
    }
    default:
      throw new TesseraError(
        `column type '${logical.asType().toString()}' has no faithful Arrow mapping. ` +
          "Project around it with columns: [...] to read the other columns.",
      );
  }
}

/**
 * Materialise the `tessera` view as an Apache Arrow {@link Table}.
 *
 * The table is fully materialized, so the connection may be closed immediately afterwards.
 *
 * @throws {NetworkError} When the read fails for a transport reason.
 * @throws {PresignExpiredError} When DuckDB reports a rejected/expired URL.
 * @throws {TesseraError} When a column has no faithful Arrow mapping.
 */
export async function readArrowFromConnection(
  connection: DuckDBConnection,
  columns?: readonly string[],
): Promise<Table> {
  const duckdb = await requireDuckDB();
  const arrow = await requireArrow();
  const projection = projectionSql(columns);

  let reader;
  try {
    reader = await connection.runAndReadAll(`SELECT ${projection} FROM tessera`);
  } catch (error) {
    throw toReaderError(error);
  }

  try {
    const names = reader.columnNames();
    const values = reader.getColumnsJS();
    const vectors: Record<string, Arrow.Vector> = {};
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index] as string;
      const type = arrowTypeFor(duckdb, arrow, reader.columnLogicalType(index));
      vectors[name] = arrow.vectorFromArray(values[index] ?? [], type);
    }
    return new arrow.Table(vectors);
  } catch (error) {
    if (error instanceof TesseraError) throw error;
    throw new TesseraError(
      `failed to materialise Arrow table: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
