import { ClaudeCliError, runClaudeCli } from "./claude-cli.ts";
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
 * CLI on the developer's machine (see claude-cli.ts). Same prompt and schema
 * as the API importer.
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
      let output: unknown;
      try {
        output = await runClaudeCli({
          command,
          model,
          systemPrompt: PROFILE_IMPORT_SYSTEM_PROMPT,
          prompt: profileImportUserMessage(input),
          jsonSchema: PROFILE_IMPORT_JSON_SCHEMA,
          timeoutMs,
        });
      } catch (err) {
        if (err instanceof ClaudeCliError) throw new ProfileImportError(`cli_${err.reason}`);
        throw err;
      }
      return readingFromJson(output);
    },
  };
}
