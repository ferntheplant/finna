import { DuckDBInstance } from "@duckdb/node-api";

const instance = await DuckDBInstance.create(process.env.FINNA_DB_PATH || ':memory:');

export const conn = await instance.connect();
