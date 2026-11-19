<div align="center">

# tessera-api

**Clean Hyperliquid market data, straight into DuckDB and Arrow.**

[![npm version](https://img.shields.io/npm/v/tessera-api.svg)](https://www.npmjs.com/package/tessera-api)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

The official TypeScript client for [**Tessera**](https://tesseralytics.dev): order-flow-enriched
OHLCV, funding-rate, and positioning datasets built from raw Hyperliquid trade data, delivered
as Parquet over a REST API.

</div>

## Why tessera-api

- **Read where the data lives.** Partitioned Parquet is read directly from object storage over
  HTTPS range requests. DuckDB pushes predicates and projections down, so only the row groups
  and columns your query touches cross the wire, with no temp files and no glue code.
- **Two shapes, one API.** An Apache Arrow `Table` for pipeline code, or an in-memory DuckDB
  connection exposing a `tessera` view you query with plain SQL.
- **Async throughout.** Native `fetch` under the hood: no callbacks, no hidden pool to close.
- **Typed end to end.** Response models are generated from the OpenAPI spec, every failure is a
  `TesseraError`, and transient failures (429/5xx, network errors) are retried with exponential
  backoff and `Retry-After` handling.

## Installation

```bash
npm install tessera-api
# optional engines:
npm install @duckdb/node-api apache-arrow
```

The engines are optional at runtime, but the public type declarations reference their types.
TypeScript consumers who typecheck without `skipLibCheck` need both installed.

Requires **Node 18.17+** (native `fetch`, `AbortSignal.timeout`). Grab a free API key (no card
required) at **[tesseralytics.dev](https://tesseralytics.dev/signup)**:

```bash
export TESSERA_API_KEY="ts_..."
```

## Free tier and history bundles

The free tier needs no card. It covers **every coin** and **all three datasets**
(`gold_ohlcv_1m`, `gold_funding_1h` and `gold_positioning_1h`) over the trailing 30 days. The
API serves that window at month granularity, so a free key sees the current and previous
calendar month; the window is the only restriction.

History beyond the window is sold as one-off download bundles of the **closed months**. Each
bundle carries all three datasets, is frozen at purchase, and is perpetual on the account:
every API key you hold inherits it.

| Bundle | Markets | Price |
| --- | --- | --- |
| Tessera Majors | BTC, ETH, SOL, HYPE | $19 once |
| Tessera HIP-3 (xyz) | Every `xyz:` HIP-3 market | $24 once |
| Tessera All Markets | Every coin Tessera publishes | $29 once |

The open month is never included. `datasets()` and `partitions()` already reflect your
entitlement, so the client needs no plan logic of its own. See
[pricing](https://tesseralytics.dev/pricing) for the full comparison.

## Datasets

| Dataset | Cadence | Columns |
| --- | --- | --- |
| `gold_ohlcv_1m` | 1 minute | OHLCV plus order-flow splits (`buy_vol`, `sell_vol`, trade counts, …) |
| `gold_funding_1h` | 1 hour | Funding rate, predicted rate, premium, next funding time |
| `gold_positioning_1h` | 1 hour | Open interest, long/short account ratios, taker buy/sell pressure |

`datasets()` returns the live catalogue for your key (names, coins, and month coverage), so
discover rather than hardcode.

## Quickstart

```ts
import { TesseraClient } from "tessera-api";

const client = new TesseraClient(); // reads $TESSERA_API_KEY

// Partitions roll on a trailing 30-day window, so discover the newest available
// month instead of hardcoding a date:
const { partitions } = await client.partitions("gold_ohlcv_1m", { coin: "BTC" });
const latest = partitions.map((p) => p.month).sort().at(-1)!;

const table = await client.readArrow("gold_ohlcv_1m", "BTC", latest, {
  columns: ["time", "close", "volume"],
});
console.log(`${table.numRows} rows for ${latest}`);
console.log(table.toArray().slice(0, 5));
```

## Arrow

`readArrow` returns an `apache-arrow` `Table`, materialised from the DuckDB view:

```ts
import { TesseraClient } from "tessera-api";

const client = new TesseraClient();
const { partitions } = await client.partitions("gold_ohlcv_1m", { coin: "BTC" });
const latest = partitions.map((p) => p.month).sort().at(-1)!;
const table = await client.readArrow("gold_ohlcv_1m", ["BTC", "ETH"], latest);
// Multi-partition reads add a `month` column; `coin` is a native column in every dataset.
console.log(table.schema.fields.map((f) => `${f.name}: ${f.type}`));
```

Column types are bridged from DuckDB's logical types, not guessed: integers keep their width,
`float32`/`float64` stay floats, `timestamp[us]` becomes `Timestamp<MICROSECOND>`, `date`
becomes `Date32<DAY>`, `time` stays `Time64`, and `list<T>` stays a `List`. A column whose
type has no faithful Arrow builder (`DECIMAL`, `HUGEINT`, `STRUCT`, `MAP`, …) raises a
`TesseraError` naming the type; project around it with `columns`.

## SQL with DuckDB

`toDuckDB` returns a DuckDB connection with a `tessera` view over the presigned Parquet;
filters and aggregations push down to object storage via `httpfs`:

```ts
import { TesseraClient } from "tessera-api";

const client = new TesseraClient();
const { partitions } = await client.partitions("gold_ohlcv_1m", { coin: "BTC" });
const latest = partitions.map((p) => p.month).sort().at(-1)!;
const connection = await client.toDuckDB("gold_ohlcv_1m", ["BTC", "ETH"], latest, {
  columns: ["time", "coin", "close", "volume"],
});

const result = await connection.runAndReadAll(
  "SELECT coin, count(*) AS bars, round(avg(close), 2) AS avg_close FROM tessera GROUP BY coin",
);
console.table(result.getRowObjectsJS());

connection.closeSync();
```

Pass `options.connection` to reuse an existing DuckDB connection instead of opening an
in-memory one; the view is created on it and the same connection is returned.

`columns` narrows both engines. `readArrow` returns exactly the requested fields; a
multi-partition `toDuckDB` view also keeps the injected `month` column (and `coin` when
selected).

Presigned URLs are short-lived (around 15 minutes). Read promptly; for long-lived graphs,
call `readArrow` or `toDuckDB` again to mint fresh URLs.

## Multiple coins and months

`coin` and `month` arguments accept a single value, an array, or an inclusive `MonthSpan`.
Multi-partition reads add a `month` column so rows stay attributable to their source
partition; `coin` is a native column in every dataset:

```ts
import { MonthSpan, TesseraClient } from "tessera-api";

const client = new TesseraClient();
const { partitions } = await client.partitions("gold_ohlcv_1m", { coin: "BTC" });
const months = partitions.map((p) => p.month).sort();
const table = await client.readArrow(
  "gold_ohlcv_1m",
  ["BTC", "ETH", "SOL"],
  new MonthSpan(months[0]!, months.at(-1)!),
);
```

The current month is *day-backed*: it has no single month object, so the API publishes one
Parquet per day. The readers concatenate those day objects transparently, so a partition is
still one logical month and provenance columns stay per partition.

Months outside the trailing 30-day window are not served (`NotFoundError`) unless your account
holds a bundle covering them. Call `partitions()` to discover what's available, as in the
quickstart.

## Configuration

```ts
import { TesseraClient } from "tessera-api";

const client = new TesseraClient(process.env.TESSERA_API_KEY, {
  baseUrl: "https://tesseralytics.dev",
  timeoutMs: 60_000,
  maxRetries: 5,
});
```

The resolved values are on `client.config` (`apiKey`, `baseUrl`, `timeoutMs`, `maxRetries`,
`userAgent`). `fetchImpl` accepts a custom `fetch`, useful for proxies, instrumentation, or
tests; auth headers and retries still apply.

## Error handling

Every failure is a `TesseraError`; API errors additionally carry `statusCode` and the
machine-readable `code`. Local validation (a malformed month, an unknown column) also throws
`TesseraError` before any request is sent:

```ts
import {
  NotFoundError,
  PresignExpiredError,
  TesseraAPIError,
  TesseraClient,
} from "tessera-api";

const client = new TesseraClient();

try {
  await client.readArrow("gold_ohlcv_1m", "BTC", "2024-01");
} catch (error) {
  if (error instanceof NotFoundError) {
    console.error("no such partition:", error.message);
  } else if (error instanceof PresignExpiredError) {
    console.error("presigned URL expired, call readArrow() again for fresh ones");
  } else if (error instanceof TesseraAPIError) {
    console.error(`HTTP ${error.statusCode} (${error.code ?? "no code"})`);
  } else {
    throw error;
  }
}
```

| Error | When |
| --- | --- |
| `ConfigurationError` | No API key resolvable, or invalid `timeoutMs`/`maxRetries` |
| `MissingDependencyError` | `@duckdb/node-api` or `apache-arrow` not installed |
| `NetworkError` | Connection or timeout failure after exhausting retries |
| `PresignExpiredError` | A presigned URL was rejected (likely expired) |
| `BadRequestError` | 400: malformed request |
| `AuthenticationError` | 401: key missing, invalid, or revoked |
| `ForbiddenError` | 403: not permitted, or the dataset is not visible to your key |
| `NotFoundError` | 404: coin or partition not visible (including months outside your window) |
| `InternalServerError` | 500: unexpected server error |
| `ServiceUnavailableError` | 502/503/504: temporarily unavailable, safe to retry |

## The raw API

The typed endpoints are also available directly, for browsing the catalogue or fetching the
Parquet bytes yourself:

```ts
import { TesseraClient, downloadUrls } from "tessera-api";

const client = new TesseraClient();

// Every dataset visible to your entitlement: name, coins, month coverage, partition count.
for (const ds of (await client.datasets()).datasets) {
  const { earliest, latest } = ds.months;
  console.log(`${ds.name} · ${ds.coins.length} coins · ${earliest ?? "?"}…${latest ?? "?"}`);
}

// Per-partition detail for one dataset: month, row count, on-disk size, …
const { partitions } = await client.partitions("gold_ohlcv_1m", { coin: "BTC" });
for (const p of partitions) {
  console.log(`${p.month} · ${p.rows ?? "-"} rows · ${Math.round(p.size_bytes / 1024 / 1024)} MiB`);
}

// Presigned download URLs for the newest partition: one object for a finalised month,
// one per day for the day-backed open month.
const latest = partitions.map((p) => p.month).sort().at(-1)!;
const download = await client.downloadUrl("gold_ohlcv_1m", "BTC", latest);
for (const url of downloadUrls(download)) console.log(url);
```

## Documentation

- Product and pricing: <https://tesseralytics.dev/pricing>
- Python client: <https://tesseralytics.dev/python-client>
- Rust client: <https://tesseralytics.dev/rust-client>

## License

GPL-3.0 © Tessera. See [LICENSE](LICENSE).
