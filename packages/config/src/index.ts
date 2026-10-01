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

  // Ingestion (M1). YouTube and transcripts are optional: without keys,
  // YouTube links are refused and videos are saved without a transcript.
  YOUTUBE_API_KEY: z.string().optional(),
  YOUTUBE_API_KEY_SECRET_ARN: z.string().optional(),
  SUPADATA_API_KEY: z.string().optional(),
  SUPADATA_API_KEY_SECRET_ARN: z.string().optional(),

  // Extracted blocks and transcripts: an S3 bucket on AWS, a directory locally.
  CONTENT_BUCKET: z.string().optional(),
  CONTENT_DIR: z.string().default(".data/content"),

  // SQS queue URLs on AWS. Unset locally, where the dev runner uses in-memory queues.
  QUEUE_URL_FETCH_SOURCE: z.string().optional(),
  QUEUE_URL_EXTRACT: z.string().optional(),
  QUEUE_URL_ENRICH: z.string().optional(),

  // Enrichment: "anthropic" (Message Batches + Bedrock embeddings) or "none" to skip it locally.
  ENRICHMENT: z.enum(["anthropic", "none"]).default("none"),
  EMBEDDING_MODEL_ID: z.string().default("amazon.titan-embed-text-v2:0"),
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

/**
 * Like fromEnvOrSecret, but null when neither is set, or when the secret
 * exists but nobody has set its value yet (Terraform creates these empty).
 */
async function optionalFromEnvOrSecret(value: string | undefined, arn: string | undefined) {
  if (value) return value;
  if (!arn) return null;
  try {
    return await getSecret(arn);
  } catch (err) {
    if ((err as { name?: string }).name === "ResourceNotFoundException") {
      console.warn(JSON.stringify({ level: "warn", message: `Secret ${arn} has no value; integration disabled` }));
      return null;
    }
    throw err;
  }
}

export function resolveYouTubeApiKey(env: Env): Promise<string | null> {
  return optionalFromEnvOrSecret(env.YOUTUBE_API_KEY, env.YOUTUBE_API_KEY_SECRET_ARN);
}

export function resolveSupadataApiKey(env: Env): Promise<string | null> {
  return optionalFromEnvOrSecret(env.SUPADATA_API_KEY, env.SUPADATA_API_KEY_SECRET_ARN);
}

export function resolveAnthropicApiKey(env: Env): Promise<string> {
  return fromEnvOrSecret(env.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY_SECRET_ARN, "ANTHROPIC_API_KEY");
}
