// Bundles the API Lambda into dist/api.zip (handler: index.handler).
import { bundleLambda } from "../../../scripts/bundle-lambda.mjs";

await bundleLambda({ name: "api", entry: "src/lambda.ts", cwd: new URL("..", import.meta.url) });
