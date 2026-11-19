import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NetworkError, PresignExpiredError, TesseraError } from "../src/errors.js";
import { partitionRef } from "../src/models.js";
import { buildConnection, readArrowFromConnection, toReaderError } from "../src/readers/duckdb.js";
import type { ResolvedPartition } from "../src/resolver.js";

const DATA_DIR_URL = new URL("./data/duckdb/", import.meta.url);
const DATA_DIR = fileURLToPath(DATA_DIR_URL);
const A = `${DATA_DIR}a.parquet`;
const B = `${DATA_DIR}b.parquet`;

const part = (coin: string, month: string, urls: string[]): ResolvedPartition => ({
  ref: partitionRef("gold_ohlcv_1m", coin, month),
  urls,
});

async function scalar(connection: DuckDBConnection, sql: string): Promise<unknown> {
  const result = await connection.runAndReadAll(sql);
  const rows = result.getRowObjectsJS();
  return Object.values(rows[0] ?? {})[0];
}

beforeAll(async () => {
  await mkdir(DATA_DIR, { recursive: true });
  const connection = await DuckDBConnection.create();
  try {
    await connection.run(
      "CREATE TABLE a AS SELECT * FROM (VALUES " +
        "('2025-09-01 00:00:00'::TIMESTAMP, 60000.5::DOUBLE, 1.5::DOUBLE, 'BTC'::VARCHAR), " +
        "('2025-09-01 00:01:00'::TIMESTAMP, 60010.0::DOUBLE, 2.5::DOUBLE, 'BTC'::VARCHAR), " +
        "('2025-09-01 00:02:00'::TIMESTAMP, 60020.25::DOUBLE, 3.5::DOUBLE, 'BTC'::VARCHAR)) t(time, close, volume, coin)",
    );
    await connection.run(
      "CREATE TABLE b AS SELECT * FROM (VALUES " +
        "('2025-09-01 00:00:00'::TIMESTAMP, 3000.5::DOUBLE, 4.5::DOUBLE, 'ETH'::VARCHAR), " +
        "('2025-09-01 00:01:00'::TIMESTAMP, 3001.0::DOUBLE, 5.5::DOUBLE, 'ETH'::VARCHAR)) t(time, close, volume, coin)",
    );
    await connection.run(`COPY a TO '${A}' (FORMAT PARQUET)`);
    await connection.run(`COPY b TO '${B}' (FORMAT PARQUET)`);
  } finally {
    connection.closeSync();
  }
});

afterAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

describe("buildConnection", () => {
  it("exposes a single partition as a tessera view", async () => {
    const connection = await buildConnection([part("BTC", "2025-09", [A])]);
    try {
      expect(await scalar(connection, "SELECT count(*) FROM tessera")).toBe(3n);
      expect(await scalar(connection, "SELECT max(close) FROM tessera")).toBe(60020.25);
    } finally {
      connection.closeSync();
    }
  });

  it("unions multiple partitions with coin and month provenance columns", async () => {
    const connection = await buildConnection([
      part("BTC", "2025-09", [A]),
      part("ETH", "2025-08", [B]),
    ]);
    try {
      expect(await scalar(connection, "SELECT count(*) FROM tessera")).toBe(5n);
      const rows = (await connection.runAndReadAll(
        "SELECT coin, month, count(*) AS n FROM tessera GROUP BY coin, month ORDER BY coin",
      )).getRowObjectsJS();
      expect(rows).toEqual([
        { coin: "BTC", month: "2025-09", n: 3n },
        { coin: "ETH", month: "2025-08", n: 2n },
      ]);
    } finally {
      connection.closeSync();
    }
  });

  it("projects the requested columns", async () => {
    const connection = await buildConnection([part("BTC", "2025-09", [A])], {
      columns: ["time", "close"],
    });
    try {
      const names = (await connection.runAndReadAll("SELECT * FROM tessera LIMIT 0")).columnNames();
      expect(names).toEqual(["time", "close"]);
    } finally {
      connection.closeSync();
    }
  });

  it("reads a day-backed partition from a list of objects", async () => {
    const connection = await buildConnection([part("BTC", "2026-10", [A, B])]);
    try {
      expect(await scalar(connection, "SELECT count(*) FROM tessera")).toBe(5n);
    } finally {
      connection.closeSync();
    }
  });

  it("reuses a caller-supplied connection", async () => {
    const connection = await DuckDBConnection.create();
    try {
      const returned = await buildConnection([part("BTC", "2025-09", [A])], { connection });
      expect(returned).toBe(connection);
      expect(await scalar(connection, "SELECT count(*) FROM tessera")).toBe(3n);
    } finally {
      connection.closeSync();
    }
  });

  it("refuses a column name that is not a bare identifier", async () => {
    const error = await buildConnection([part("BTC", "2025-09", [A])], {
      columns: ["close; DROP TABLE x"],
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TesseraError);
    expect((error as Error).message).toBe("invalid column name: 'close; DROP TABLE x'");
  });

  it("maps a missing parquet file to NetworkError", async () => {
    const error = await buildConnection([
      part("BTC", "2025-09", [`${DATA_DIR}missing.parquet`]),
    ]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toMatch(/missing\.parquet/);
  });

  it("translates a rejected/expired URL into PresignExpiredError", () => {
    const error = toReaderError(
      new Error("HTTP Error: HTTP GET error on 'https://x/y.parquet' (HTTP 403 Forbidden)"),
    );
    expect(error).toBeInstanceOf(PresignExpiredError);
    expect((error as Error).message).toMatch(/call toDuckDB\(\)\/readArrow\(\) again/);
  });

  it("does not treat an unrelated 403 number as a presign failure", () => {
    expect(toReaderError(new Error("conversion error at row 403"))).toBeInstanceOf(NetworkError);
  });
});

describe("readArrowFromConnection", () => {
  it("materialises the view as an Arrow table with bridged types", async () => {
    const connection = await buildConnection([part("BTC", "2025-09", [A])]);
    try {
      const table = await readArrowFromConnection(connection);
      expect(table.numRows).toBe(3);
      expect(table.schema.fields.map((field) => `${field.name}:${field.type}`)).toEqual([
        "time:Timestamp<MICROSECOND>",
        "close:Float64",
        "volume:Float64",
        "coin:Utf8",
      ]);
      expect(table.getChild("close")?.get(0)).toBe(60000.5);
      // 2025-09-01T00:00:00Z; Arrow's vector `get` normalises timestamps to epoch ms.
      expect(table.getChild("time")?.get(0)).toBe(1_756_684_800_000);
    } finally {
      connection.closeSync();
    }
  });

  it("bridges lists and days and refuses unmapped types", async () => {
    const connection = await DuckDBConnection.create();
    try {
      await connection.run(
        "CREATE TABLE shapes AS SELECT " +
          "[1.5, 2.5]::DOUBLE[] AS lst, '2025-09-01'::DATE AS d, 1.25::DECIMAL(18,6) AS dec",
      );
      await connection.run("CREATE OR REPLACE TEMP VIEW tessera AS SELECT lst, d FROM shapes");
      const table = await readArrowFromConnection(connection);
      expect(table.schema.fields.map((field) => `${field.name}:${field.type}`)).toEqual([
        "lst:List<Float64>",
        "d:Date32<DAY>",
      ]);
      expect(table.getChild("d")?.get(0)).toBe(1_756_684_800_000);

      await connection.run("CREATE OR REPLACE TEMP VIEW tessera AS SELECT dec FROM shapes");
      await expect(readArrowFromConnection(connection)).rejects.toThrowError(
        /DECIMAL\(18,6\).*no faithful Arrow mapping/,
      );
    } finally {
      connection.closeSync();
    }
  });

  it("projects columns", async () => {
    const connection = await buildConnection([part("BTC", "2025-09", [A])]);
    try {
      const table = await readArrowFromConnection(connection, ["close"]);
      expect(table.schema.fields.map((field) => field.name)).toEqual(["close"]);
      expect(table.numRows).toBe(3);
    } finally {
      connection.closeSync();
    }
  });

  it("keeps coin/month columns for multi-partition reads", async () => {
    const connection = await buildConnection([
      part("BTC", "2025-09", [A]),
      part("ETH", "2025-08", [B]),
    ]);
    try {
      const table = await readArrowFromConnection(connection);
      expect(table.numRows).toBe(5);
      expect(table.schema.fields.map((field) => field.name)).toContain("coin");
      expect(table.schema.fields.map((field) => field.name)).toContain("month");
      expect(table.schema.fields.map((field) => field.name)).not.toContain("coin_1");
      expect(
        (await connection.runAndReadAll(
          "SELECT coin, count(*) AS n FROM tessera GROUP BY coin ORDER BY coin",
        )).getRowObjectsJS(),
      ).toEqual([
        { coin: "BTC", n: 3n },
        { coin: "ETH", n: 2n },
      ]);
    } finally {
      connection.closeSync();
    }
  });
});
