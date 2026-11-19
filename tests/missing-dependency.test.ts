import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@duckdb/node-api");
  vi.doUnmock("apache-arrow");
});

describe("optional engine dependencies", () => {
  it("raises MissingDependencyError when @duckdb/node-api is absent", async () => {
    vi.resetModules();
    vi.doMock("@duckdb/node-api", () => {
      throw new Error("Cannot find module '@duckdb/node-api'");
    });
    const reader = await import("../src/readers/duckdb.js");
    const error = await reader.requireDuckDB().catch((err: unknown) => err);
    // Fresh module graph after `resetModules`, so compare by class name, not identity.
    expect(error).toMatchObject({ name: "MissingDependencyError" });
    expect((error as Error).message).toContain("npm install @duckdb/node-api");
  });

  it("raises MissingDependencyError when apache-arrow is absent", async () => {
    vi.resetModules();
    vi.doMock("apache-arrow", () => {
      throw new Error("Cannot find module 'apache-arrow'");
    });
    const reader = await import("../src/readers/duckdb.js");
    const error = await reader.requireArrow().catch((err: unknown) => err);
    expect(error).toMatchObject({ name: "MissingDependencyError" });
    expect((error as Error).message).toContain("npm install apache-arrow");
  });
});
