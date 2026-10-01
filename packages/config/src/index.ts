import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";

/**
 * Runtime configuration shared by the API and workers.
 *
 * Locally everything comes from plain env vars (see .env.example).
 * On AWS, Terraform sets *_SECRET_ARN variables instead, and the values are
 * read from Secrets Manager once per Lambda cold start.
 */

const envSchema = z.object({
  APP_ENV: z.enum(["local", "test", "dev", "prod"]).default("local"),

  // Local: a full connection string.
  DATABASE_URL: z.string().url().optional(),
  // AWS: host/port/name plus the RDS-managed master secret ({ username, password }).
  DB_HOST: z.string().optional(),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_NAME: z.string().default("founder_signal"),
  DB_SECRET_ARN: z.string().optional(),

  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_SECRET_ARN: z.string().optional(),
  BETTER_AUTH_URL: z.string().url().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY_SECRET_ARN: z.string().optional(),

  EMAIL_TRANSPORT: z.enum(["console", "ses"]).default("console"),
  EMAIL_FROM: z.string().default("letters@example.com"),

  CLIENT_LOG_SINK: z.enum(["console", "cloudwatch"]).default("console"),
  CLIENT_LOG_GROUP: z.string().default("/founder-signal/local/mobile"),
});

export type Env = z.infer<typeof envSchema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

let secretsClient: SecretsManagerClient | undefined;
const secretCache = new Map<string, Promise<string>>();

/** Reads a Secrets Manager secret string, cached for the life of the process. */
export function getSecret(arn: string): Promise<string> {
  let value = secretCache.get(arn);
  if (!value) {
    secretsClient ??= new SecretsManagerClient({});
    value = secretsClient
      .send(new GetSecretValueCommand({ SecretId: arn }))
      .then((res) => {
        if (!res.SecretString) throw new Error(`Secret ${arn} has no string value`);
        return res.SecretString;
      });
    // Don't cache failures, so the next invocation can retry.
    value.catch(() => secretCache.delete(arn));
    secretCache.set(arn, value);
  }
  return value;
}

const rdsSecretSchema = z.object({ username: z.string(), password: z.string() });

export interface DatabaseConfig {
  connectionString: string;
  /** True on AWS, where RDS enforces TLS (rds.force_ssl=1). */
  ssl: boolean;
}

export async function resolveDatabaseConfig(env: Env): Promise<DatabaseConfig> {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, ssl: false };
  if (!env.DB_HOST || !env.DB_SECRET_ARN) {
    throw new Error("Set DATABASE_URL (local) or DB_HOST + DB_SECRET_ARN (AWS)");
  }
  const { username, password } = rdsSecretSchema.parse(JSON.parse(await getSecret(env.DB_SECRET_ARN)));
  const url = new URL(`postgres://${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  return { connectionString: url.toString(), ssl: true };
}

async function fromEnvOrSecret(value: string | undefined, arn: string | undefined, name: string) {
  if (value) return value;
  if (arn) return getSecret(arn);
  throw new Error(`Set ${name} or ${name}_SECRET_ARN`);
}

export function resolveBetterAuthSecret(env: Env): Promise<string> {
  return fromEnvOrSecret(env.BETTER_AUTH_SECRET, env.BETTER_AUTH_SECRET_ARN, "BETTER_AUTH_SECRET");
}

export function resolveAnthropicApiKey(env: Env): Promise<string> {
  return fromEnvOrSecret(env.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY_SECRET_ARN, "ANTHROPIC_API_KEY");
}
