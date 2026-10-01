# Everything one environment needs. envs/dev and envs/prod call this with different settings.

locals {
  name = "founder-signal-${var.env}"
}

module "network" {
  source            = "../network"
  name              = local.name
  cidr              = var.vpc_cidr
  nat_mode          = var.nat_mode
  nat_gateway_count = var.nat_gateway_count
}

module "database" {
  source            = "../database"
  name              = local.name
  subnet_ids        = module.network.private_subnet_ids
  security_group_id = module.network.db_security_group_id

  instance_class               = var.db_instance_class
  multi_az                     = var.db_multi_az
  backup_retention_days        = var.db_backup_retention_days
  deletion_protection          = var.db_deletion_protection
  skip_final_snapshot          = var.db_skip_final_snapshot
  performance_insights_enabled = var.db_performance_insights
  enable_proxy                 = var.db_enable_proxy
}

module "secrets" {
  source               = "../secrets"
  env                  = var.env
  recovery_window_days = var.secret_recovery_window_days
}

module "observability" {
  source             = "../observability"
  env                = var.env
  alert_email        = var.alert_email
  log_retention_days = var.log_retention_days
}

locals {
  vpc_config = {
    subnet_ids         = module.network.private_subnet_ids
    security_group_ids = [module.network.lambda_security_group_id]
  }

  secret_arns = [
    module.database.master_secret_arn,
    module.secrets.better_auth_secret_arn,
    module.secrets.anthropic_api_key_secret_arn,
  ]

  # Env contract shared by the api and migrate functions (the app reads exactly these).
  # BETTER_AUTH_URL is added by the api module; migrate gets the same value below.
  app_env = {
    NODE_ENV                     = "production"
    APP_ENV                      = var.env
    DB_HOST                      = module.database.connect_host
    DB_PORT                      = tostring(module.database.port)
    DB_NAME                      = module.database.db_name
    DB_SECRET_ARN                = module.database.master_secret_arn
    BETTER_AUTH_SECRET_ARN       = module.secrets.better_auth_secret_arn
    ANTHROPIC_API_KEY_SECRET_ARN = module.secrets.anthropic_api_key_secret_arn
    EMAIL_TRANSPORT              = "ses"
    EMAIL_FROM                   = var.email_from
    CLIENT_LOG_SINK              = "cloudwatch"
    CLIENT_LOG_GROUP             = module.observability.mobile_log_group_name
  }
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    sid       = "ReadAppSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.secret_arns
  }
}

data "aws_iam_policy_document" "api" {
  source_policy_documents = [data.aws_iam_policy_document.read_secrets.json]

  statement {
    sid       = "WriteMobileLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${module.observability.mobile_log_group_arn}:*"]
  }

  # TODO(M5): scope to the SES identity ARN once the domain is verified.
  statement {
    sid       = "SendEmail"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["*"]
  }
}

module "api" {
  source = "../api"

  name             = "${local.name}-api"
  artifacts_bucket = var.artifacts_bucket
  release          = var.release
  runtime          = var.lambda_runtime
  vpc_config       = local.vpc_config
  policy_json      = data.aws_iam_policy_document.api.json
  environment      = local.app_env

  log_retention_days = var.log_retention_days
  domain_name        = var.api_domain_name
  certificate_arn    = var.api_certificate_arn
}

module "migrate" {
  source = "../lambda_fn"

  name             = "${local.name}-migrate"
  description      = "Runs database migrations; invoked by CI/operator before a release goes live"
  artifact_name    = "migrate"
  artifacts_bucket = var.artifacts_bucket
  release          = var.release
  runtime          = var.lambda_runtime
  timeout_seconds  = 300
  memory_mb        = 512
  vpc_config       = local.vpc_config
  policy_json      = data.aws_iam_policy_document.read_secrets.json
  environment      = merge(local.app_env, { BETTER_AUTH_URL = module.api.public_url })

  log_retention_days = var.log_retention_days
}
