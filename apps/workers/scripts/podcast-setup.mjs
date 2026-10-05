// Sets up the podcast experiment's local voice (Kokoro-82M, Apache-2.0): the Python venv in
// apps/workers/tts (with uv) and the model files in apps/workers/tts/models (~355 MB, gitignored).
//   pnpm --filter @fs/workers podcast:setup
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ttsDir = new URL("../tts/", import.meta.url).pathname;
const models = join(ttsDir, "models");
const uv = process.env.UV_PATH ?? "uv";

// The ONNX export from Hugging Face (fast CDN); the voices from kokoro-onnx's GitHub release.
const FILES = [
  { name: "kokoro-v1.0.onnx", url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx" },
  { name: "voices-v1.0.bin", url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin" },
];

console.log(`• uv sync (${ttsDir})`);
const sync = spawnSync(uv, ["sync", "--frozen", "--project", ttsDir], { stdio: "inherit" });
if (sync.error || sync.status !== 0) {
  console.error(`✗ uv sync failed. Is uv installed? (https://docs.astral.sh/uv/; or set UV_PATH)`);
  process.exit(1);
}

mkdirSync(models, { recursive: true });
for (const { name, url } of FILES) {
  const path = join(models, name);
  if (existsSync(path)) {
    console.log(`• ${name} already there`);
    continue;
  }
  console.log(`• downloading ${name}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${path}.part`));
  renameSync(`${path}.part`, path);
}

const which = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
console.log(
  which.error
    ? "• no ffmpeg: episodes are encoded with macOS's afconvert (chapters stay in the database, not the file)"
    : "• ffmpeg found: episodes get chapters in the file too",
);
console.log("✓ Ready. Try: pnpm --filter @fs/workers podcast <itemId|url>");
