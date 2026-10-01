// Shared esbuild setup for every Lambda: one ESM file + the RDS CA bundle, zipped.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * @param {{ name: string, entry: string, cwd: URL, copy?: { from: string, to: string }[] }} opts
 */
export async function bundleLambda({ name, entry, cwd, copy = [] }) {
  const appDir = fileURLToPath(cwd);
  const outDir = `${appDir}dist/${name}`;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  await build({
    entryPoints: [`${appDir}${entry}`],
    outfile: `${outDir}/index.mjs`,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    minify: true,
    legalComments: "none",
    // The Lambda Node.js runtime ships AWS SDK v3; pg-native is an optional pg addon we don't use.
    external: ["@aws-sdk/*", "pg-native"],
    // Some bundled CommonJS dependencies call require(); give them one in ESM.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "warning",
  });

  copyFileSync(`${repoRoot}packages/db/certs/rds-global-bundle.pem`, `${outDir}/rds-global-bundle.pem`);
  for (const { from, to } of copy) cpSync(`${appDir}${from}`, `${outDir}/${to}`, { recursive: true });

  const zipPath = `${appDir}dist/${name}.zip`;
  rmSync(zipPath, { force: true });
  execFileSync("zip", ["-qr", zipPath, "."], { cwd: outDir });
  console.log(`Bundled ${name} → ${zipPath}`);
}
