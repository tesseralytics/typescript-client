import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backoffDelay } from "../src/config.js";
import { NetworkError, TesseraAPIError } from "../src/errors.js";
import { TesseraClient } from "../src/client.js";
import { API_KEY, BASE_URL, DATASETS_BODY, json, sequence, stubFetch } from "./fixtures.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const clientFor = (fetchImpl: typeof fetch, maxRetries: number): TesseraClient =>
  new TesseraClient(API_KEY, { baseUrl: BASE_URL, fetchImpl, maxRetries });

describe("backoffDelay", () => {
  it("honours Retry-After in seconds", () => {
    expect(backoffDelay(0, 12)).toBe(12_000);
    expect(backoffDelay(3, 0)).toBe(0);
  });

  it("jitters exponentially when no Retry-After is given", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(backoffDelay(0, null)).toBe(250);
    expect(backoffDelay(2, null)).toBe(1000);
    expect(backoffDelay(1, -1)).toBe(500);
  });
});

describe("retry policy", () => {
  it("retries a 429 and honours Retry-After", async () => {
    const stub = stubFetch({
      "/v1/datasets": sequence(
        json({ error: "unavailable" }, 429, { "Retry-After": "12" }),
        json(DATASETS_BODY),
      ),
    });
    const pending = clientFor(stub.fetchImpl, 1).datasets();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(stub.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ generated_at: "2025-09-27T10:30:00Z" });
    expect(stub.calls).toHaveLength(2);
  });

  it("retries a transport failure, then succeeds", async () => {
    let attempt = 0;
    const fetchImpl = async (): Promise<Response> => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify(DATASETS_BODY), { status: 200 });
    };
    const pending = clientFor(fetchImpl as typeof fetch, 1).datasets();
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ generated_at: "2025-09-27T10:30:00Z" });
    expect(attempt).toBe(2);
  });

  it("raises NetworkError once transport failures exhaust the retries", async () => {
    let attempts = 0;
    const fetchImpl = async (): Promise<Response> => {
      attempts += 1;
      throw new TypeError("getaddrinfo ENOTFOUND");
    };
    const pending = clientFor(fetchImpl as typeof fetch, 2).datasets();
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    const error = await settled;
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toContain("network error contacting Tessera");
    expect((error as Error).message).toContain("ENOTFOUND");
    expect(attempts).toBe(3);
  });

  it("surfaces the last 5xx response once retries are exhausted", async () => {
    const stub = stubFetch({ "/v1/datasets": json({ error: "unavailable" }, 503) });
    const pending = clientFor(stub.fetchImpl, 2).datasets();
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await settled;
    expect(error).toBeInstanceOf(TesseraAPIError);
    expect(error).toMatchObject({ statusCode: 503, code: "unavailable" });
    expect(stub.calls).toHaveLength(3);
  });

  it("cancels a retryable response body before backing off", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const stub = stubFetch({
      "/v1/datasets": sequence(
        () => new Response(body, { status: 503 }),
        json(DATASETS_BODY),
      ),
    });
    const pending = clientFor(stub.fetchImpl, 1).datasets();
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ generated_at: "2025-09-27T10:30:00Z" });
    expect(cancelled).toBe(true);
  });

  it("does not retry a 404", async () => {
    const stub = stubFetch({ "/v1/datasets/nope": json({ error: "not_found" }, 404) });
    await expect(clientFor(stub.fetchImpl, 3).partitions("nope")).rejects.toThrowError(
      /HTTP 404/,
    );
    expect(stub.calls).toHaveLength(1);
  });
});
