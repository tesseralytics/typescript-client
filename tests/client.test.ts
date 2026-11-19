import { afterEach, describe, expect, it } from "vitest";

import {
  AuthenticationError,
  ConfigurationError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  TesseraAPIError,
  errorFromResponse,
} from "../src/errors.js";
import type { DayDownloadResponse } from "../src/models.js";
import { TesseraClient } from "../src/client.js";
import { VERSION } from "../src/version.js";
import {
  API_KEY,
  BASE_URL,
  DATASETS_BODY,
  DAY_DOWNLOAD_BODY,
  DOWNLOAD_BODY,
  PARTITIONS_BODY,
  type StubFetch,
  json,
  stubFetch,
} from "./fixtures.js";

afterEach(() => {
  delete process.env.TESSERA_API_KEY;
});

describe("constructor", () => {
  it("refuses to start without an API key", () => {
    expect(() => new TesseraClient()).toThrowError(ConfigurationError);
    expect(() => new TesseraClient()).toThrowError(/No API key provided/);
  });

  it("falls back to $TESSERA_API_KEY", async () => {
    process.env.TESSERA_API_KEY = "from-env";
    const stub = stubFetch({ "/v1/datasets": json(DATASETS_BODY) });
    const client = new TesseraClient(undefined, { baseUrl: BASE_URL, fetchImpl: stub.fetchImpl });
    await client.datasets();
    expect(stub.calls[0]?.headers.get("authorization")).toBe("Bearer from-env");
  });

  it("prefers the explicit key over the environment", async () => {
    process.env.TESSERA_API_KEY = "from-env";
    const stub = stubFetch({ "/v1/datasets": json(DATASETS_BODY) });
    const client = new TesseraClient("explicit", { baseUrl: BASE_URL, fetchImpl: stub.fetchImpl });
    await client.datasets();
    expect(stub.calls[0]?.headers.get("authorization")).toBe("Bearer explicit");
  });

  it("strips a trailing slash from the base URL", async () => {
    const stub = stubFetch({ "/v1/datasets": json(DATASETS_BODY) });
    const client = new TesseraClient(API_KEY, {
      baseUrl: `${BASE_URL}/`,
      fetchImpl: stub.fetchImpl,
    });
    await client.datasets();
    expect(stub.calls[0]?.url.href).toBe(`${BASE_URL}/v1/datasets`);
  });
});

describe("requests", () => {
  const makeClient = (): { client: TesseraClient; stub: StubFetch } => {
    const stub = stubFetch({
      "/v1/datasets": json(DATASETS_BODY),
      "/v1/datasets/gold_ohlcv_1m": json(PARTITIONS_BODY),
      "/v1/datasets/gold_ohlcv_1m/BTC/2025-09/download": json(DOWNLOAD_BODY),
      "/v1/datasets/gold_ohlcv_1m/BTC/2026-10/download": json(DAY_DOWNLOAD_BODY),
    });
    return { client: new TesseraClient(API_KEY, { baseUrl: BASE_URL, fetchImpl: stub.fetchImpl }), stub };
  };

  it("sends bearer auth, the client user agent, and JSON accept", async () => {
    const { client, stub } = makeClient();
    const body = await client.datasets();
    expect(body.datasets[0]?.name).toBe("gold_ohlcv_1m");
    expect(body.datasets[0]?.months.latest).toBe("2025-09");
    const call = stub.calls[0];
    expect(call?.url.href).toBe(`${BASE_URL}/v1/datasets`);
    expect(call?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(call?.headers.get("user-agent")).toBe(`tessera-typescript/${VERSION}`);
    expect(call?.headers.get("accept")).toBe("application/json");
    expect(call?.init.redirect).toBe("manual");
  });

  it("passes coin/month filters as query params", async () => {
    const { client, stub } = makeClient();
    const body = await client.partitions("gold_ohlcv_1m", { coin: "BTC", month: "2025-09" });
    expect(body.partitions[0]?.size_bytes).toBe(1024);
    const url = stub.calls[0]?.url;
    expect(url?.pathname).toBe("/v1/datasets/gold_ohlcv_1m");
    expect([...(url?.searchParams.entries() ?? [])]).toEqual([
      ["coin", "BTC"],
      ["month", "2025-09"],
    ]);
  });

  it("omits filters that were not supplied", async () => {
    const { client, stub } = makeClient();
    await client.partitions("gold_ohlcv_1m");
    expect(stub.calls[0]?.url.search).toBe("");
  });

  it("URL-encodes asset, coin, and month path segments", async () => {
    const stub = stubFetch({
      "/v1/datasets/a%2Fb/BTC%20X/2025-09/download": json(DOWNLOAD_BODY),
    });
    const client = new TesseraClient(API_KEY, { baseUrl: BASE_URL, fetchImpl: stub.fetchImpl });
    await client.downloadUrl("a/b", "BTC X", "2025-09");
    expect(stub.calls[0]?.url.pathname).toBe("/v1/datasets/a%2Fb/BTC%20X/2025-09/download");
  });

  it("returns a single-object download for a finalised month", async () => {
    const { client } = makeClient();
    const body = await client.downloadUrl("gold_ohlcv_1m", "BTC", "2025-09");
    expect("days" in body).toBe(false);
    expect("url" in body && body.url).toBe("https://tigris/x.parquet");
  });

  it("returns per-day downloads for the open month", async () => {
    const { client } = makeClient();
    const body = await client.downloadUrl("gold_ohlcv_1m", "BTC", "2026-10");
    expect("days" in body).toBe(true);
    expect(body as DayDownloadResponse).toMatchObject({ is_open: true });
    expect((body as DayDownloadResponse).days).toHaveLength(2);
  });

  it("rejects a download body with neither shape", async () => {
    const stub = stubFetch({
      "/v1/datasets/gold_ohlcv_1m/BTC/2025-09/download": json({ nonsense: true }),
    });
    const client = new TesseraClient(API_KEY, { baseUrl: BASE_URL, fetchImpl: stub.fetchImpl });
    await expect(client.downloadUrl("gold_ohlcv_1m", "BTC", "2025-09")).rejects.toThrowError(
      /unrecognised body/,
    );
  });
});

describe("error mapping", () => {
  const errorFor = (path: string, status: number, body: unknown): TesseraClient => {
    const stub = stubFetch({ [path]: () => new Response(JSON.stringify(body), { status }) });
    return new TesseraClient(API_KEY, { baseUrl: BASE_URL, fetchImpl: stub.fetchImpl, maxRetries: 0 });
  };

  it("maps 404 + not_found to NotFoundError", async () => {
    const client = errorFor("/v1/datasets/nope", 404, { error: "not_found" });
    const error = await client.partitions("nope").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ statusCode: 404, code: "not_found" });
    expect((error as Error).message).toBe("Tessera API request failed with HTTP 404 (not_found)");
  });

  it("maps 403 + forbidden to ForbiddenError", async () => {
    const client = errorFor("/v1/datasets/gold_funding_1h", 403, { error: "forbidden" });
    const error = await client.partitions("gold_funding_1h").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ statusCode: 403, code: "forbidden" });
  });

  it("maps 503 with an empty body to ServiceUnavailableError", async () => {
    const client = errorFor("/v1/datasets", 503, {});
    const error = await client.datasets().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toMatchObject({ statusCode: 503, code: null });
  });

  it("falls back to a generic API error for an unmapped status", async () => {
    const client = errorFor("/v1/datasets", 418, { error: "teapot" });
    const error = await client.datasets().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TesseraAPIError);
    expect(error).toMatchObject({ statusCode: 418, code: "teapot" });
  });

  it("surfaces a 302 instead of following it", async () => {
    const stub = stubFetch({
      "/v1/datasets/gold_ohlcv_1m/BTC/2025-09/download": () =>
        new Response("redirecting", { status: 302, headers: { Location: "https://tigris/x" } }),
    });
    const client = new TesseraClient(API_KEY, { baseUrl: BASE_URL, fetchImpl: stub.fetchImpl });
    const error = await client.downloadUrl("gold_ohlcv_1m", "BTC", "2025-09").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TesseraAPIError);
    expect(error).toMatchObject({ statusCode: 302 });
    expect(stub.calls).toHaveLength(1);
  });

  it("ignores an unparseable error body", () => {
    const error = errorFromResponse(401, "not json at all");
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.code).toBeNull();
  });
});
