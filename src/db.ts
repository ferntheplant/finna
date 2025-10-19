import { DuckDBInstance } from "@duckdb/node-api";

const instance = await DuckDBInstance.create(process.env.FINNA_DB_PATH || ':memory:');

const conn = await instance.connect();

await conn.run(`SET ui_local_port = 4213;`);
await conn.run(`CALL start_ui_server();`);

export { conn };
