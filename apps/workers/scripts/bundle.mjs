// Bundles each worker Lambda into dist/<name>.zip (handler: index.handler).
import { bundleLambda } from "../../../scripts/bundle-lambda.mjs";

const cwd = new URL("..", import.meta.url);

await bundleLambda({
  name: "migrate",
  entry: "src/migrate.ts",
  cwd,
  copy: [{ from: "../../packages/db/migrations", to: "migrations" }],
});

for (const name of ["sweep", "fetch-source", "extract", "enrich"]) {
  await bundleLambda({ name, entry: `src/handlers/${name}.ts`, cwd });
}
