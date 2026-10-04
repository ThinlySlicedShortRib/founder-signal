import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";

/**
 * Local development only: runs a prompt through the Claude Code CLI on the
 * developer's machine (`claude -p` with structured output), so it runs on
 * their Claude login with no API key. Never used on AWS, where Lambda has no
 * CLI. Shared by the profile importer, the letter writer, the reader's
 * summaries and the author enricher.
 */

export class ClaudeCliError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Claude CLI failed: ${reason}`);
    this.name = "ClaudeCliError";
    this.reason = reason;
  }
}

export interface ClaudeCliOptions {
  command?: string;
  /** A CLI model alias ("haiku", "sonnet") or a full model ID. */
  model: string;
  systemPrompt: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  /** CLI tools to allow, e.g. ["WebSearch"]. None by default. */
  tools?: string[];
  timeoutMs?: number;
  maxBudgetUsd?: number;
}

/** Returns the structured output, or throws ClaudeCliError. */
export async function runClaudeCli({
  command = "claude",
  model,
  systemPrompt,
  prompt,
  jsonSchema,
  tools = [],
  timeoutMs = 90_000,
  maxBudgetUsd = 0.5,
}: ClaudeCliOptions): Promise<unknown> {
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(jsonSchema),
    "--system-prompt", systemPrompt,
    "--model", model,
    "--tools", tools.join(","),
    // The run shouldn't be saved as a session.
    "--no-session-persistence",
    "--max-budget-usd", String(maxBudgetUsd),
  ];
  // Headless runs can't ask for permission, so the allowed tools are pre-approved.
  if (tools.length) args.push("--allowedTools", tools.join(","));

  const stdout = await run(command, args, prompt, timeoutMs);
  let out: { is_error?: boolean; subtype?: string; structured_output?: unknown };
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new ClaudeCliError("invalid_json");
  }
  if (out.is_error || out.subtype !== "success") throw new ClaudeCliError(out.subtype ?? "error");
  if (out.structured_output === undefined) throw new ClaudeCliError("no_structured_output");
  return out.structured_output;
}

function run(command: string, args: string[], stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Run outside the repo so the CLI doesn't load this project's CLAUDE.md, hooks or settings.
    // Thinking off: these are quick, bounded tasks, and thinking made them ~5x slower (44s → 9s).
    const child = spawn(command, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MAX_THINKING_TOKENS: "0" } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ClaudeCliError("timeout"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ClaudeCliError(`unavailable: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new ClaudeCliError(`exit_${code}: ${err.slice(0, 300)}`));
    });
    child.stdin.end(stdin);
  });
}

/** A JSON schema for structured outputs (API and CLI) from a zod schema, without the `$schema` key. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
