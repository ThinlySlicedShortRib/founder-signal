# Founder Signal infrastructure (Terraform)

One AWS project for now, `dev`, in region `ap-southeast-2` (Sydney). It's an account on the new AWS experience, which is single-region: every regional resource lives in `ap-southeast-2`, and only global services (CloudFront, its WAF and its ACM certificates) may use `us-east-1`. Nothing here is cross-region, so the API's custom-domain certificate is issued in `ap-southeast-2` too. `envs/prod` is parked: CI still validates it, but nothing applies it until a prod project exists.

Each environment is `envs/<env>` → `modules/stack`, which wires the modules below.

| Module | What it creates | GCP equivalent |
|---|---|---|
| `bootstrap/` | State bucket, Lambda artifacts bucket, optional GitHub OIDC deploy role | GCS state bucket + Artifact Registry + Workload Identity Federation |
| `modules/network` | VPC, 2 public + 2 private subnets, S3 gateway endpoint, NAT (fck-nat or managed gateway), `lambda` and `db` security groups | VPC + Cloud NAT + firewall rules |
| `modules/database` | RDS PostgreSQL 17 (TLS enforced, encrypted, RDS-managed password secret), optional RDS Proxy | Cloud SQL for PostgreSQL (+ managed connection pooling) |
| `modules/secrets` | Better Auth secret (generated); Anthropic, YouTube, Supadata and Unsplash key secrets (values set by hand) | Secret Manager |
| `modules/lambda_fn` | One Lambda from `s3://<artifacts>/<release>/<name>.zip`, its IAM role, its log group | Cloud Run function + service account |
| `modules/api` | HTTP API → `$default` route → Hono Lambda, access logs, throttling, optional custom domain | API Gateway / Cloud Run URL + domain mapping |
| `modules/observability` | `/founder-signal/<env>/mobile` log group, `MobileErrors` metric + alarm, alerts SNS topic | Cloud Logging bucket + log-based metric + alerting policy |
| `modules/queues` | One SQS queue + DLQ per pipeline step (`fetch-source`, `extract`, `enrich`, `letter-step`, `author`, `discover`), DLQ-depth alarms → alerts topic | Cloud Tasks queues / Pub/Sub + dead-letter topics |
| `modules/content_storage` | Private, KMS-encrypted, TLS-only bucket for extracted blocks and transcripts | GCS bucket with CMEK |
| `modules/image_storage` | Private bucket for copies of articles' lead images, served by a CloudFront distribution through origin access control; only `letter-step` writes `images/*` | GCS bucket behind Cloud CDN |
| `modules/scheduler` | EventBridge Scheduler `rate(5 minutes)` → `sweep` | Cloud Scheduler |
| `modules/stack` | Wires all of the above for one environment, plus the `migrate` Lambda, the ingestion workers (`sweep`, `fetch-source`, `extract`, `enrich`), the letter engine (`letter-step`, `author`) and open web discovery (`discover`) | — |

**NAT:** dev uses the community module [`RaJiska/fck-nat/aws`](https://registry.terraform.io/modules/RaJiska/fck-nat/aws) (a `t4g.nano` in an auto-scaling group of one, with a static ENI so routes survive a replacement; SSM Session Manager access, no SSH). Prod uses a managed NAT gateway (`nat_gateway_count` = 1, or 2 for one per AZ).

## Lambda contract

- Zips live at `s3://<artifacts_bucket>/<release>/<name>.zip` for `api`, `migrate`, `sweep`, `fetch-source`, `extract`, `enrich`, `letter-step`, `author` and `discover`. Each contains `index.js` (or `index.mjs`) exporting `handler`. Runtime `nodejs24.x`, `arm64`.
- Workers additionally get `QUEUE_URL_FETCH_SOURCE`, `QUEUE_URL_EXTRACT`, `QUEUE_URL_ENRICH`, `QUEUE_URL_LETTER_STEP`, `QUEUE_URL_AUTHOR`, `QUEUE_URL_DISCOVER`, `UNSPLASH_ACCESS_KEY_SECRET_ARN`, `CONTENT_BUCKET`, `SUPADATA_API_KEY_SECRET_ARN`, `ENRICHMENT` (`anthropic` or `none`), `DISCOVERY` (`anthropic` or `none`) and `EMBEDDING_MODEL_ID`. Queue consumers report partial batch failures, so only failed messages are retried (3 receives, then the DLQ).
- Each worker's role can read only the secrets it needs and send only to the queues it feeds. Only `enrich`, `letter-step`, `author` and `discover` can read the Anthropic key; only `enrich` can call Bedrock, and only on the embedding model. The API additionally gets `CONTENT_BUCKET` (read-only, for the reader), `QUEUE_URL_LETTER_STEP` (send-only, for test letters and the first letter) and `QUEUE_URL_DISCOVER` (send-only, for the discovery run the first letter waits on), plus the same `DISCOVERY` switch as the workers.
- Both functions get: `NODE_ENV`, `APP_ENV`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_SECRET_ARN` (RDS-managed JSON `{username,password}`), `BETTER_AUTH_SECRET_ARN`, `BETTER_AUTH_URL`, `ANTHROPIC_API_KEY_SECRET_ARN`, `EMAIL_TRANSPORT=ses`, `EMAIL_FROM`, `CLIENT_LOG_SINK=cloudwatch`, `CLIENT_LOG_GROUP`.
- `BETTER_AUTH_URL` is the custom domain if set, otherwise the execute-api URL. There's no dependency cycle, because the API resource is created before the function and the integration after it.
- The database requires TLS (`rds.force_ssl=1`). Connect with SSL on, using the RDS CA bundle or `rejectUnauthorized: false` inside the VPC.

## First-time setup

```bash
# 0. Credentials for the dev project (`aws login --profile founder-signal-dev`)
export AWS_PROFILE=founder-signal-dev AWS_REGION=ap-southeast-2

# 1. Bootstrap (local state, run once)
cd infra/bootstrap
cp terraform.tfvars.example terraform.tfvars   # env = "dev"
terraform init && terraform apply
terraform output                                # note state_bucket + artifacts_bucket

# 2. Backend + variables for the environment
cd ../envs/dev
cp backend.hcl.example backend.hcl              # fill in state bucket
cp terraform.tfvars.example terraform.tfvars    # fill in artifacts bucket, email_from, release

# 3. Build and upload the Lambda bundles (from the repo root)
RELEASE=$(git rev-parse --short HEAD)
pnpm bundle                                      # produces apps/api/dist/api.zip and apps/workers/dist/<worker>.zip
aws s3 cp apps/api/dist/api.zip s3://<artifacts_bucket>/$RELEASE/api.zip
for w in migrate sweep fetch-source extract enrich letter-step author discover; do
  aws s3 cp apps/workers/dist/$w.zip s3://<artifacts_bucket>/$RELEASE/$w.zip
done

# 4. Apply
terraform init -backend-config=backend.hcl
terraform apply -var release=$RELEASE

# 5. Set the API keys (the secrets exist but have no value). YouTube and
#    Supadata are optional: until set, YouTube links are refused and videos
#    are saved without a transcript.
aws secretsmanager put-secret-value \
  --secret-id founder-signal/dev/anthropic-api-key --secret-string 'sk-ant-...'
aws secretsmanager put-secret-value \
  --secret-id founder-signal/dev/youtube-api-key --secret-string 'AIza...'
aws secretsmanager put-secret-value \
  --secret-id founder-signal/dev/supadata-api-key --secret-string 'sd_...'
#    Optional: stock photos for pieces without their own image.
aws secretsmanager put-secret-value \
  --secret-id founder-signal/dev/unsplash-access-key --secret-string '...'
#    Enrichment also needs Bedrock access to the embedding model
#    (Titan Text Embeddings V2) in the Bedrock console → Model access.
#    Without it, set enrichment_enabled = false in the stack.
#    Discovery (web search before each letter) uses the same Anthropic key and is billed per
#    search (capped per letter). To turn it off, set discovery_enabled = false in the stack.

# 6. Run migrations
aws lambda invoke --function-name founder-signal-dev-migrate \
  --cli-binary-format raw-in-base64-out --payload '{}' /dev/stdout
```

Later deploys repeat steps 3, 4 (with the new `RELEASE`) and 6.

## Rough dev cost

| Item | Per month |
|---|---|
| fck-nat (`t4g.nano` + EBS + public IPv4) | ~$7 |
| RDS `db.t4g.micro` single-AZ + 20 GB gp3 | ~$12–15 + ~$2.30 |
| Secrets Manager (5 secrets × $0.40) | ~$2.00 |
| Lambda, API Gateway, SQS, EventBridge Scheduler, CloudWatch, S3, SNS | pennies at personal volume |

Prod adds Multi-AZ RDS (~2× the DB) and a managed NAT gateway (~$37 each).
