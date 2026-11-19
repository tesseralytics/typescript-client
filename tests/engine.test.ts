import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TesseraClient } from "../src/client.js";
import { API_KEY, BASE_URL, DOWNLOAD_BODY, json, stubFetch } from "./fixtures.js";

const DATA_DIR = new URL("./data/engine/", import.meta.url);
const A = pathToFileURL(`${DATA_DIR.pathname}engine-a.parquet`).href;
const B = pathToFileURL(`${DATA_DIR.pathname}engine-b.parquet`).href;

const downloadPath = (coin: string): string => `/v1/datasets/gold_ohlcv_1m/${coin}/2025-09/download`;

function clientOver(presigned: Record<string, string>): {
  client: TesseraClient;
  stub: ReturnType<typeof stubFetch>;
} {
  const routes: Record<string, () => Response> = {};
  for (const [coin, url] of Object.entries(presigned)) {
    routes[downloadPath(coin)] = json({ ...DOWNLOAD_BODY, url });
  }
  const stub = stubFetch(routes);
  return {
    client: new TesseraClient(API_KEY, { baseUrl: BASE_URL, fetchImpl: stub.fetchImpl }),
    stub,
  };
}

beforeAll(async () => {
  await mkdir(DATA_DIR, { recursive: true });
  const connection = await DuckDBConnection.create();
  try {
    await connection.run(
      "CREATE TABLE a AS SELECT * FROM (VALUES " +
        "('2025-09-01 00:00:00'::TIMESTAMP, 60000.5::DOUBLE, 'BTC'::VARCHAR), " +
        "('2025-09-01 00:01:00'::TIMESTAMP, 60010::DOUBLE, 'BTC'::VARCHAR)) t(time, close, coin)",
    );
    await connection.run(
      "CREATE TABLE b AS SELECT * FROM (VALUES ('2025-09-01 00:00:00'::TIMESTAMP, 3000.5::DOUBLE, 'ETH'::VARCHAR)) t(time, close, coin)",
    );
    await connection.run(`COPY a TO '${new URL(A).pathname}' (FORMAT PARQUET)`);
    await connection.run(`COPY b TO '${new URL(B).pathname}' (FORMAT PARQUET)`);
  } finally {
    connection.closeSync();
  }
});

afterAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

describe("engine methods", () => {
  it("readArrow mints one URL per partition and unions them", async () => {
    const { client, stub } = clientOver({ BTC: A, ETH: B });
    const table = await client.readArrow("gold_ohlcv_1m", ["BTC", "ETH"], "2025-09");

    expect(table.numRows).toBe(3);
    expect(table.schema.fields.map((field) => field.name)).toEqual([
      "time",
      "close",
      "coin",
      "month",
    ]);
    expect(table.schema.fields.map((field) => field.name)).not.toContain("coin_1");
    expect(stub.calls.map((call) => call.url.pathname).sort()).toEqual([
      downloadPath("BTC"),
      downloadPath("ETH"),
    ]);
    expect(stub.calls[0]?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("projects coin on a multi-partition read without renaming it", async () => {
    const { client } = clientOver({ BTC: A, ETH: B });
    const table = await client.readArrow("gold_ohlcv_1m", ["BTC", "ETH"], "2025-09", {
      columns: ["time", "coin", "close"],
    });

    expect(table.schema.fields.map((field) => field.name)).toEqual(["time", "coin", "close"]);
    expect(table.getChild("coin")?.toArray()).toEqual(["BTC", "BTC", "ETH"]);
  });

  it("toDuckDB exposes the tessera view on an owned connection", async () => {
    const { client } = clientOver({ BTC: A });
    const connection = await client.toDuckDB("gold_ohlcv_1m", "BTC", "2025-09", {
      columns: ["time", "close"],
    });
    try {
      const rows = (await connection.runAndReadAll(
        "SELECT count(*) AS n, max(close) AS top FROM tessera",
      )).getRowObjectsJS();
      expect(rows).toEqual([{ n: 2n, top: 60010 }]);
    } finally {
      connection.closeSync();
    }
  });

  it("toDuckDB reuses a caller-supplied connection", async () => {
    const { client } = clientOver({ BTC: A });
    const existing = await DuckDBConnection.create();
    try {
      const returned = await client.toDuckDB("gold_ohlcv_1m", "BTC", "2025-09", {
        connection: existing,
      });
      expect(returned).toBe(existing);
      expect(
        (await existing.runAndReadAll("SELECT count(*) AS n FROM tessera")).getRowObjectsJS(),
      ).toEqual([{ n: 2n }]);
    } finally {
      existing.closeSync();
    }
  });

  it("propagates a minted-URL failure", async () => {
    const stub = stubFetch({
      [downloadPath("BTC")]: () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    });
    const client = new TesseraClient(API_KEY, {
      baseUrl: BASE_URL,
      fetchImpl: stub.fetchImpl,
      maxRetries: 0,
    });
    await expect(client.readArrow("gold_ohlcv_1m", "BTC", "2025-09")).rejects.toThrowError(
      /HTTP 404/,
    );
  });
});
