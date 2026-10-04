import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  PROFILE_IMPORT_JSON_SCHEMA,
  PROFILE_IMPORT_PROMPT_VERSION,
  PROFILE_IMPORT_SYSTEM_PROMPT,
  ProfileImportError,
  type ProfileImporter,
  profileImportUserMessage,
  readingFromJson,
} from "./profile-import.ts";

/**
 * Local development only: reads an imported profile through the Claude Code
 * CLI on the developer's machine (`claude -p` with structured output), so it
 * runs on their Claude login with no API key. Same prompt and schema as the
 * API importer. Never used on AWS, where Lambda has no CLI.
 */
export function claudeCliProfileImporter({
  command = "claude",
  model = "haiku",
  timeoutMs = 90_000,
}: { command?: string; model?: string; timeoutMs?: number } = {}): ProfileImporter {
  return {
    method: "claude-cli",
    model: `claude-cli:${model}`,
    promptVersion: PROFILE_IMPORT_PROMPT_VERSION,
    async read(input) {
      const stdout = await run(
        command,
        [
          "-p",
          "--output-format", "json",
          "--json-schema", JSON.stringify(PROFILE_IMPORT_JSON_SCHEMA),
          "--system-prompt", PROFILE_IMPORT_SYSTEM_PROMPT,
          "--model", model,
          // Reading a note needs no tools, and the run shouldn't be saved as a session.
          "--tools", "",
          "--no-session-persistence",
          "--max-budget-usd", "0.50",
        ],
        profileImportUserMessage(input),
        timeoutMs,
      );
      let out: { is_error?: boolean; subtype?: string; structured_output?: unknown; result?: string };
      try {
        out = JSON.parse(stdout);
      } catch {
        throw new ProfileImportError("cli_invalid_json");
      }
      if (out.is_error || out.subtype !== "success") throw new ProfileImportError(`cli_${out.subtype ?? "error"}`);
      if (out.structured_output === undefined) throw new ProfileImportError("cli_no_structured_output");
      return readingFromJson(out.structured_output);
    },
  };
}

function run(command: string, args: string[], stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Run outside the repo so the CLI doesn't load this project's CLAUDE.md, hooks or settings.
    // Thinking off: it's a quick extraction, like the API importer, and thinking made it ~5x slower (44s → 9s).
    const child = spawn(command, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MAX_THINKING_TOKENS: "0" } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ProfileImportError("cli_timeout"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ProfileImportError(`cli_unavailable: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new ProfileImportError(`cli_exit_${code}: ${err.slice(0, 300)}`));
    });
    child.stdin.end(stdin);
  });
}
