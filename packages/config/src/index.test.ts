import { describe, expect, it } from "vitest";
import { readEnv, resolveAnthropicApiKey, resolveBetterAuthSecret, resolveDatabaseConfig } from "./index.ts";

describe("readEnv", () => {
  it("applies defaults", () => {
    const env = readEnv({});
    expect(env).toMatchObject({ APP_ENV: "local", DB_PORT: 5432, EMAIL_TRANSPORT: "console", CLIENT_LOG_SINK: "console" });
  });

  it("rejects a short auth secret", () => {
    expect(() => readEnv({ BETTER_AUTH_SECRET: "short" })).toThrow(/Invalid environment/);
  });
});

describe("resolveDatabaseConfig", () => {
  it("uses DATABASE_URL without TLS locally", async () => {
    const env = readEnv({ DATABASE_URL: "postgres://fs:fs@localhost:5433/founder_signal" });
    expect(await resolveDatabaseConfig(env)).toEqual({
      connectionString: "postgres://fs:fs@localhost:5433/founder_signal",
      ssl: false,
    });
  });

  it("requires either DATABASE_URL or DB_HOST + DB_SECRET_ARN", async () => {
    await expect(resolveDatabaseConfig(readEnv({ DB_HOST: "db.internal" }))).rejects.toThrow(/DATABASE_URL/);
  });
});

describe("secrets", () => {
  it("prefers plain env values over secret ARNs", async () => {
    const env = readEnv({ BETTER_AUTH_SECRET: "x".repeat(32), ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(await resolveBetterAuthSecret(env)).toBe("x".repeat(32));
    expect(await resolveAnthropicApiKey(env)).toBe("sk-ant-test");
  });

  it("names the missing variable", async () => {
    await expect(resolveAnthropicApiKey(readEnv({}))).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
