# Founder Signal infrastructure (Terraform)

One AWS account per environment (`dev`, `prod`), region `us-east-1`. Each environment is `envs/<env>` → `modules/stack`, which wires the modules below.

| Module | What it creates | GCP equivalent |
|---|---|---|
| `bootstrap/` | State bucket, Lambda artifacts bucket, optional GitHub OIDC deploy role | GCS state bucket + Artifact Registry + Workload Identity Federation |
| `modules/network` | VPC, 2 public + 2 private subnets, S3 gateway endpoint, NAT (fck-nat or managed gateway), `lambda` and `db` security groups | VPC + Cloud NAT + firewall rules |
| `modules/database` | RDS PostgreSQL 17 (TLS enforced, encrypted, RDS-managed password secret), optional RDS Proxy | Cloud SQL for PostgreSQL (+ managed connection pooling) |
| `modules/secrets` | Better Auth secret (generated), Anthropic API key secret (value set by hand) | Secret Manager |
| `modules/lambda_fn` | One Lambda from `s3://<artifacts>/<release>/<name>.zip`, its IAM role, its log group | Cloud Run function + service account |
| `modules/api` | HTTP API → `$default` route → Hono Lambda, access logs, throttling, optional custom domain | API Gateway / Cloud Run URL + domain mapping |
| `modules/observability` | `/founder-signal/<env>/mobile` log group, `MobileErrors` metric + alarm, alerts SNS topic | Cloud Logging bucket + log-based metric + alerting policy |
| `modules/stack` | Wires all of the above for one environment, plus the `migrate` Lambda | — |

**NAT:** dev uses the community module [`RaJiska/fck-nat/aws`](https://registry.terraform.io/modules/RaJiska/fck-nat/aws) (a `t4g.nano` in an auto-scaling group of one, with a static ENI so routes survive a replacement; SSM Session Manager access, no SSH). Prod uses a managed NAT gateway (`nat_gateway_count` = 1, or 2 for one per AZ).

## Lambda contract

- Zips live at `s3://<artifacts_bucket>/<release>/api.zip` and `.../migrate.zip`. Each contains `index.js` (or `index.mjs`) exporting `handler`. Runtime `nodejs24.x`, `arm64`.
- Both functions get: `NODE_ENV`, `APP_ENV`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_SECRET_ARN` (RDS-managed JSON `{username,password}`), `BETTER_AUTH_SECRET_ARN`, `BETTER_AUTH_URL`, `ANTHROPIC_API_KEY_SECRET_ARN`, `EMAIL_TRANSPORT=ses`, `EMAIL_FROM`, `CLIENT_LOG_SINK=cloudwatch`, `CLIENT_LOG_GROUP`.
- `BETTER_AUTH_URL` is the custom domain if set, otherwise the execute-api URL. There's no dependency cycle, because the API resource is created before the function and the integration after it.
- The database requires TLS (`rds.force_ssl=1`). Connect with SSL on, using the RDS CA bundle or `rejectUnauthorized: false` inside the VPC.

## First-time setup (per account)

```bash
# 0. Credentials for the target account (IAM Identity Center profile recommended)
export AWS_PROFILE=founder-signal-dev

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
pnpm bundle                                      # produces apps/api/dist/api.zip, apps/workers/dist/migrate.zip
aws s3 cp apps/api/dist/api.zip         s3://<artifacts_bucket>/$RELEASE/api.zip
aws s3 cp apps/workers/dist/migrate.zip s3://<artifacts_bucket>/$RELEASE/migrate.zip

# 4. Apply
terraform init -backend-config=backend.hcl
terraform apply -var release=$RELEASE

# 5. Set the Anthropic key (the secret exists but has no value)
aws secretsmanager put-secret-value \
  --secret-id founder-signal/dev/anthropic-api-key --secret-string 'sk-ant-...'

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
| Secrets Manager (3 secrets × $0.40) | ~$1.20 |
| Lambda, API Gateway, CloudWatch, S3, SNS | pennies at personal volume |

Prod adds Multi-AZ RDS (~2× the DB) and a managed NAT gateway (~$37 each).
