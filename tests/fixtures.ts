/** Shared response bodies and a `fetch` stub for the client tests. */

export const API_KEY = "test-key";
export const BASE_URL = "https://api.test";

export const DATASETS_BODY = {
  generated_at: "2025-09-27T10:30:00Z",
  datasets: [
    {
      name: "gold_ohlcv_1m",
      partition_count: 2,
      coins: ["BTC", "ETH"],
      months: { earliest: "2025-08", latest: "2025-09" },
    },
  ],
};

export const PARTITIONS_BODY = {
  asset: "gold_ohlcv_1m",
  generated_at: "2025-09-27T10:30:00Z",
  partitions: [
    { coin: "BTC", month: "2025-09", size_bytes: 1024, modified_at: null },
  ],
};

export const DOWNLOAD_BODY = {
  url: "https://tigris/x.parquet",
  expires_at: "2025-09-27T10:45:00Z",
};

export const DAY_DOWNLOAD_BODY = {
  asset: "gold_ohlcv_1m",
  coin: "BTC",
  month: "2026-10",
  is_open: true,
  days: [
    { date: "2026-10-02", url: "https://tigris/02.parquet", expires_at: "t" },
    { date: "2026-10-01", url: "https://tigris/01.parquet", expires_at: "t" },
  ],
};

export interface RecordedCall {
  readonly url: URL;
  readonly init: RequestInit;
  readonly headers: Headers;
}

type RouteHandler = (call: RecordedCall) => Response;

export interface StubFetch {
  readonly fetchImpl: typeof fetch;
  readonly calls: RecordedCall[];
}

/** Build a `fetch` stub that routes by pathname and records every call. */
export function stubFetch(routes: Record<string, RouteHandler>): StubFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (
    input: Parameters<typeof fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call: RecordedCall = { url, init, headers: new Headers(init.headers) };
    calls.push(call);
    const handler = routes[url.pathname];
    if (handler === undefined) {
      throw new TypeError(`unexpected fetch: ${url.pathname}`);
    }
    return handler(call);
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

/** A route handler that replays the given responses in order. */
export function sequence(...responses: (() => Response)[]): RouteHandler {
  let index = 0;
  return () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return (next ?? (() => new Response(null, { status: 500 })))();
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
