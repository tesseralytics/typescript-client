/**
 * End-to-end smoke test against the live API.
 *
 *   npm install @duckdb/node-api apache-arrow
 *   npm run build
 *   TESSERA_API_KEY=ts_... node examples/quickstart.mjs
 */

import { TesseraClient } from "../dist/index.js";

const client = new TesseraClient();

// 1. The catalogue: what your key can see.
const { datasets } = await client.datasets();
console.log(`${datasets.length} datasets visible to this key:`);
for (const dataset of datasets) {
  const { earliest, latest } = dataset.months;
  console.log(
    `  ${dataset.name.padEnd(22)} ${String(dataset.coins.length).padStart(3)} coins  ` +
      `${earliest ?? "?"}…${latest ?? "?"}  (${dataset.partition_count} partitions)`,
  );
}

// 2. The newest BTC month of the 1-minute OHLCV dataset.
const asset = "gold_ohlcv_1m";
const { partitions } = await client.partitions(asset, { coin: "BTC" });
const months = partitions.map((partition) => partition.month).sort();
const latest = months.at(-1);
if (latest === undefined) {
  console.error(`no BTC partitions visible for ${asset}`);
  process.exit(1);
}
console.log(`\nnewest BTC partition: ${latest}`);

// 3. Arrow: a filtered, projected slice.
const table = await client.readArrow(asset, "BTC", latest, {
  columns: ["time", "close", "volume"],
});
console.log(`arrow table: ${table.numRows} rows`);
console.log(table.schema.fields.map((field) => `${field.name}:${field.type}`).join(", "));
console.log(table.toArray().slice(0, 3));

// 4. DuckDB: SQL over the presigned Parquet.
const connection = await client.toDuckDB(asset, "BTC", latest, {
  columns: ["time", "close", "volume"],
});
try {
  const result = await connection.runAndReadAll(
    "SELECT count(*) AS bars, round(avg(close), 2) AS avg_close, " +
      "round(sum(volume), 2) AS volume FROM tessera",
  );
  console.log("\nduckdb:", result.getRowObjectsJS());
} finally {
  connection.closeSync();
}
