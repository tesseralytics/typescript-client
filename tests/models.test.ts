import { describe, expect, it } from "vitest";

import { TesseraError } from "../src/errors.js";
import {
  MonthSpan,
  downloadUrls,
  expandRefs,
  normalizeMonths,
  objectKey,
  partitionRef,
  validateMonth,
} from "../src/models.js";
import { DAY_DOWNLOAD_BODY, DOWNLOAD_BODY } from "./fixtures.js";

describe("validateMonth", () => {
  it("accepts YYYY-MM", () => {
    expect(validateMonth("2025-09")).toBe("2025-09");
    expect(validateMonth("2025-01")).toBe("2025-01");
    expect(validateMonth("2025-12")).toBe("2025-12");
  });

  it.each(["2025-13", "2025-00", "25-09", "2025-9", "2025-09-01", ""])(
    "rejects %s with the Python message",
    (month) => {
      expect(() => validateMonth(month)).toThrowError(TesseraError);
      expect(() => validateMonth(month)).toThrowError(
        /^month must be in YYYY-MM format, got '/,
      );
    },
  );
});

describe("MonthSpan", () => {
  it("iterates every month inclusively, across a year boundary", () => {
    expect(new MonthSpan("2025-11", "2026-02").months()).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("yields a single month when start equals end", () => {
    expect([...new MonthSpan("2025-09", "2025-09")]).toEqual(["2025-09"]);
  });

  it("rejects a reversed span", () => {
    expect(() => new MonthSpan("2025-09", "2025-01")).toThrowError(
      "MonthSpan start '2025-09' is after end '2025-01'",
    );
  });

  it("rejects an invalid endpoint", () => {
    expect(() => new MonthSpan("2025-09", "2025-1")).toThrowError(/YYYY-MM/);
  });
});

describe("normalizeMonths", () => {
  it("expands a span, a single month, and a list", () => {
    expect(normalizeMonths(new MonthSpan("2025-01", "2025-02"))).toEqual(["2025-01", "2025-02"]);
    expect(normalizeMonths("2025-09")).toEqual(["2025-09"]);
    expect(normalizeMonths(["2025-08", "2025-09"])).toEqual(["2025-08", "2025-09"]);
  });

  it("validates every month in a list", () => {
    expect(() => normalizeMonths(["2025-08", "nope"])).toThrowError(/YYYY-MM/);
  });
});

describe("downloadUrls", () => {
  it("returns the single object of a finalised month", () => {
    expect(downloadUrls(DOWNLOAD_BODY)).toEqual(["https://tigris/x.parquet"]);
  });

  it("orders day objects oldest first", () => {
    expect(downloadUrls(DAY_DOWNLOAD_BODY)).toEqual([
      "https://tigris/01.parquet",
      "https://tigris/02.parquet",
    ]);
  });

  it("refuses a day-backed body with no day objects", () => {
    expect(() => downloadUrls({ ...DAY_DOWNLOAD_BODY, days: [] })).toThrowError(TesseraError);
    expect(() => downloadUrls({ ...DAY_DOWNLOAD_BODY, days: [] })).toThrowError(
      /returned no day objects/,
    );
  });
});

describe("partitions", () => {
  it("uses the object-storage key layout", () => {
    expect(objectKey(partitionRef("gold_ohlcv_1m", "BTC", "2025-09"))).toBe(
      "gold_ohlcv_1m/coin=BTC/month=2025-09.parquet",
    );
  });

  it("validates the month when building a ref", () => {
    expect(() => partitionRef("gold_ohlcv_1m", "BTC", "2025-9")).toThrowError(/YYYY-MM/);
  });

  it("expands coin-major cartesian product", () => {
    expect(expandRefs("gold_ohlcv_1m", ["BTC", "ETH"], ["2025-08", "2025-09"])).toEqual([
      { asset: "gold_ohlcv_1m", coin: "BTC", month: "2025-08" },
      { asset: "gold_ohlcv_1m", coin: "BTC", month: "2025-09" },
      { asset: "gold_ohlcv_1m", coin: "ETH", month: "2025-08" },
      { asset: "gold_ohlcv_1m", coin: "ETH", month: "2025-09" },
    ]);
  });

  it("refuses an empty coin or month list", () => {
    expect(() => expandRefs("gold_ohlcv_1m", [], "2025-09")).toThrowError(
      "at least one coin is required",
    );
    expect(() => expandRefs("gold_ohlcv_1m", "BTC", [])).toThrowError(
      "at least one month is required",
    );
  });

  it("accepts a MonthSpan as the month argument", () => {
    expect(expandRefs("gold_ohlcv_1m", "BTC", new MonthSpan("2025-08", "2025-09"))).toHaveLength(2);
  });
});
