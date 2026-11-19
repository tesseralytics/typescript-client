/**
 * Public data models and ergonomic helpers.
 *
 * The wire models are generated from the OpenAPI spec (`npm run codegen`); this module
 * re-exports them under stable names alongside hand-written helpers
 * ({@link PartitionRef}, {@link MonthSpan}, {@link downloadUrls}).
 */

import type { components } from "./generated/schema.js";
import { TesseraError } from "./errors.js";

export type DatasetSummary = components["schemas"]["DatasetSummary"];
export type DatasetsResponse = components["schemas"]["DatasetsResponse"];
export type PartitionsResponse = components["schemas"]["PartitionsResponse"];
export type Partition = components["schemas"]["Partition"];
export type MonthRange = components["schemas"]["MonthRange"];
export type DownloadResponse = components["schemas"]["DownloadResponse"];
export type DayDownload = components["schemas"]["DayDownload"];
export type DayDownloadResponse = components["schemas"]["DayDownloadResponse"];
export type ErrorBody = components["schemas"]["ErrorBody"];

/**
 * A download body: one object for a finalised month, or one object per day for the
 * day-backed open month.
 */
export type Download = DownloadResponse | DayDownloadResponse;

/** Flatten either download shape into presigned URLs, oldest day first. */
export function downloadUrls(body: Download): string[] {
  if ("days" in body) {
    const urls = [...body.days]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((day) => day.url);
    if (urls.length === 0) {
      throw new TesseraError(
        `Download of day-backed partition ${body.asset}/${body.coin ?? ""}/${body.month} ` +
          "returned no day objects.",
      );
    }
    return urls;
  }
  return [body.url];
}

/** `YYYY-MM`, zero-padded, month 01–12. */
export const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Validate a `YYYY-MM` month, returning it unchanged. */
export function validateMonth(month: string): string {
  if (!MONTH_REGEX.test(month)) {
    throw new TesseraError(`month must be in YYYY-MM format, got '${month}'`);
  }
  return month;
}

/** A fully-qualified reference to a single partition. */
export interface PartitionRef {
  readonly asset: string;
  readonly coin: string;
  readonly month: string;
}

/** Build a {@link PartitionRef}, validating the month. */
export function partitionRef(asset: string, coin: string, month: string): PartitionRef {
  return { asset, coin, month: validateMonth(month) };
}

/** The object-storage key layout: `{asset}/coin={COIN}/month={YYYY-MM}.parquet`. */
export function objectKey(ref: PartitionRef): string {
  return `${ref.asset}/coin=${ref.coin}/month=${ref.month}.parquet`;
}

/**
 * An inclusive range of months, e.g. `new MonthSpan("2025-01", "2025-09")`.
 *
 * Pass it anywhere a `month` argument is accepted to expand to every month in the
 * range (inclusive of both endpoints).
 */
export class MonthSpan implements Iterable<string> {
  readonly start: string;
  readonly end: string;

  constructor(start: string, end: string) {
    this.start = validateMonth(start);
    this.end = validateMonth(end);
    if (this.start > this.end) {
      throw new TesseraError(`MonthSpan start '${this.start}' is after end '${this.end}'`);
    }
  }

  /** Return the months in the span as `YYYY-MM` strings. */
  months(): string[] {
    return [...this];
  }

  *[Symbol.iterator](): Iterator<string> {
    let [year, month] = this.start.split("-").map(Number) as [number, number];
    const [endYear, endMonth] = this.end.split("-").map(Number) as [number, number];
    while (year < endYear || (year === endYear && month <= endMonth)) {
      yield `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
}

/** Accepted shapes for the `coin` argument on reader methods. */
export type Coins = string | readonly string[];

/** Accepted shapes for the `month` argument on reader methods. */
export type Months = string | readonly string[] | MonthSpan;

/** Coerce a coin argument into a list of coin symbols. */
export function normalizeCoins(coin: Coins): string[] {
  return typeof coin === "string" ? [coin] : [...coin];
}

/** Coerce a month argument into a list of validated `YYYY-MM` strings. */
export function normalizeMonths(month: Months): string[] {
  if (month instanceof MonthSpan) return month.months();
  const months = typeof month === "string" ? [month] : [...month];
  return months.map(validateMonth);
}

/** Expand `(asset, coins, months)` into the cartesian list of partitions. */
export function expandRefs(asset: string, coins: Coins, months: Months): PartitionRef[] {
  const coinList = normalizeCoins(coins);
  const monthList = normalizeMonths(months);
  if (coinList.length === 0) throw new TesseraError("at least one coin is required");
  if (monthList.length === 0) throw new TesseraError("at least one month is required");
  const refs: PartitionRef[] = [];
  for (const coin of coinList) {
    for (const month of monthList) refs.push({ asset, coin, month });
  }
  return refs;
}
