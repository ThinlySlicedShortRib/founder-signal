import { readEnv } from "@fs/config";
import { handle } from "hono/aws-lambda";
import { buildApp } from "./bootstrap.ts";

// Runs once per cold start: reads secrets and opens the DB pool.
const app = await buildApp(readEnv());

export const handler = handle(app);
