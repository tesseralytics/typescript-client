/**
 * Concurrent presigned-URL resolution.
 *
 * Each `(asset, coin, month)` partition needs its own short-lived presigned URL, minted
 * via the download endpoint. Multi-partition reads resolve them concurrently, capped so
 * a 24-month read does not open 24 sockets at once.
 */

import type { PartitionRef } from "./models.js";

/** A resolved partition: its reference plus one presigned URL per object. */
export interface ResolvedPartition {
  readonly ref: PartitionRef;
  readonly urls: readonly string[];
}

const MAX_CONCURRENCY = 8;

/**
 * Resolve presigned URLs for `refs` concurrently, preserving input order.
 *
 * At most {@link MAX_CONCURRENCY} resolutions are in flight at a time; the first
 * rejection rejects the whole batch.
 */
export async function resolveRefs(
  fetchUrls: (ref: PartitionRef) => Promise<string[]>,
  refs: readonly PartitionRef[],
): Promise<ResolvedPartition[]> {
  const resolved = new Array<ResolvedPartition>(refs.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (let index = next++; index < refs.length; index = next++) {
      const ref = refs[index] as PartitionRef;
      resolved[index] = { ref, urls: await fetchUrls(ref) };
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(MAX_CONCURRENCY, refs.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return resolved;
}
