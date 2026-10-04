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
    # The API validates YouTube links when sources are added.
    module.secrets.youtube_api_key_secret_arn,
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
    YOUTUBE_API_KEY_SECRET_ARN   = module.secrets.youtube_api_key_secret_arn
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

  # The reader's full text and transcripts.
  statement {
    sid       = "ReadContent"
    actions   = ["s3:GetObject"]
    resources = ["${module.content.bucket_arn}/items/*"]
  }

  # POST /me/schedule/test-letter starts the letter pipeline.
  statement {
    sid       = "StartLetters"
    actions   = ["sqs:SendMessage"]
    resources = [module.queues.arns["letter-step"]]
  }

  # Finishing onboarding (and a test letter with little to pick from) starts a discovery run
  # that the letter waits on (§6.3a).
  statement {
    sid       = "StartDiscovery"
    actions   = ["sqs:SendMessage"]
    resources = [module.queues.arns["discover"]]
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
  environment = merge(local.app_env, {
    CONTENT_BUCKET        = module.content.bucket_name
    QUEUE_URL_LETTER_STEP = module.queues.urls["letter-step"]
    QUEUE_URL_DISCOVER    = module.queues.urls["discover"]
    # Same switch as the workers: with "none", on-demand letters don't wait for a discovery run.
    DISCOVERY = var.discovery_enabled ? "anthropic" : "none"
  })

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

# --- Ingestion pipeline (M1): sweep → fetch-source → extract → enrich -----------
# --- Letter engine (M3): sweep → letter-step (×5 steps) → author ----------------
# --- Discovery (M3, §6.3a): sweep → discover → extract ----------------------------
# All workers run in the VPC because they use the database. Fetch traffic goes
# through the NAT; at personal volume that costs nothing on fck-nat (no
# per-GB charge) and little on a managed gateway. See build plan §2.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

module "content" {
  source        = "../content_storage"
  bucket_name   = "${local.name}-content-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.content_force_destroy
}

module "images" {
  source        = "../image_storage"
  bucket_name   = "${local.name}-images-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.content_force_destroy
}

locals {
  # Queue consumers. visibility = 6x the function timeout (AWS guidance for SQS triggers).
  workers = {
    sweep = {
      description = "Every 5 minutes: claims due sources, queues enrichment, starts discovery and due letters, publisher catalog, watchdog, delivery"
      timeout     = 60
      memory      = 256
      queue       = null
      batch_size  = null
      concurrency = null
      sends_to    = ["fetch-source", "enrich", "letter-step", "discover"]
      secrets     = [module.database.master_secret_arn]
      content     = []
      bedrock     = false
      images      = false
    }
    fetch-source = {
      description = "Lists a source's entries and queues new items for extraction"
      timeout     = 60
      memory      = 512
      queue       = "fetch-source"
      batch_size  = 1
      concurrency = 5
      sends_to    = ["extract"]
      secrets     = [module.database.master_secret_arn, module.secrets.youtube_api_key_secret_arn]
      content     = []
      bedrock     = false
      images      = false
    }
    extract = {
      description = "Fetches and extracts one item, applies the rights gate"
      timeout     = 120
      memory      = 1024
      queue       = "extract"
      batch_size  = 5
      concurrency = 5
      # Re-queues itself to wait out per-host politeness; starts a letter held for the page it extracted.
      sends_to = ["extract", "letter-step"]
      secrets = [
        module.database.master_secret_arn,
        module.secrets.youtube_api_key_secret_arn,
        module.secrets.supadata_api_key_secret_arn,
      ]
      content = ["s3:PutObject"]
      bedrock = false
      images  = false
    }
    enrich = {
      description = "Submits and applies Message Batches; computes embeddings"
      timeout     = 300
      memory      = 512
      queue       = "enrich"
      batch_size  = 1
      concurrency = 2
      sends_to    = []
      secrets     = [module.database.master_secret_arn, module.secrets.anthropic_api_key_secret_arn]
      content     = ["s3:GetObject"]
      bedrock     = true
      images      = false
    }
    # M3: the letter engine (build plan §6.2). One message per step; steps claim the letter with a
    # compare-and-set on its status, so duplicates are harmless.
    letter-step = {
      description = "Runs one letter step: collect, rank, generate (Sonnet 5.5), verify and lock"
      timeout     = 300
      memory      = 512
      queue       = "letter-step"
      batch_size  = 1
      concurrency = 5
      # Queues its own next step, and author lookups at lock.
      sends_to = ["letter-step", "author"]
      secrets = [
        module.database.master_secret_arn,
        module.secrets.anthropic_api_key_secret_arn,
        module.secrets.unsplash_access_key_secret_arn,
      ]
      content = ["s3:GetObject"]
      bedrock = false
      images  = true
    }
    author = {
      description = "Looks up an author card with Claude and web search, once per ~90 days"
      timeout     = 300
      memory      = 256
      queue       = "author"
      batch_size  = 1
      # Web search is slow and billed per search; there's no hurry.
      concurrency = 2
      sends_to    = []
      secrets     = [module.database.master_secret_arn, module.secrets.anthropic_api_key_secret_arn]
      content     = []
      bedrock     = false
      images      = false
    }
    # Open web discovery (build plan §6.3a): a few hours before each letter, queries (Haiku 4.5) and
    # web searches (Sonnet 5.5), capped per letter; found pages go to extract like any other item.
    discover = {
      description = "Searches the open web for a user's next letter and queues what it finds for extraction"
      timeout     = 300
      memory      = 512
      queue       = "discover"
      batch_size  = 1
      # Web search is slow and billed per search. Most runs are hours ahead of their letter; an
      # on-demand one (first letter) has a user waiting, but two at a time is plenty at this volume.
      concurrency = 2
      # Starts a letter held for the run once it has ended (the first letter, some test letters).
      sends_to = ["extract", "letter-step"]
      secrets  = [module.database.master_secret_arn, module.secrets.anthropic_api_key_secret_arn]
      content  = []
      bedrock  = false
      images   = false
    }
  }

  queued_workers = { for k, w in local.workers : k => w if w.queue != null }

  embedding_model_arn = "arn:aws:bedrock:${data.aws_region.current.region}::foundation-model/${var.embedding_model_id}"

  worker_env = merge(local.app_env, {
    QUEUE_URL_FETCH_SOURCE         = module.queues.urls["fetch-source"]
    QUEUE_URL_EXTRACT              = module.queues.urls["extract"]
    QUEUE_URL_ENRICH               = module.queues.urls["enrich"]
    QUEUE_URL_LETTER_STEP          = module.queues.urls["letter-step"]
    QUEUE_URL_AUTHOR               = module.queues.urls["author"]
    QUEUE_URL_DISCOVER             = module.queues.urls["discover"]
    UNSPLASH_ACCESS_KEY_SECRET_ARN = module.secrets.unsplash_access_key_secret_arn
    CONTENT_BUCKET                 = module.content.bucket_name
    IMAGES_BUCKET                  = module.images.bucket_name
    IMAGES_BASE_URL                = module.images.base_url
    SUPADATA_API_KEY_SECRET_ARN    = module.secrets.supadata_api_key_secret_arn
    ENRICHMENT                     = var.enrichment_enabled ? "anthropic" : "none"
    DISCOVERY                      = var.discovery_enabled ? "anthropic" : "none"
    EMBEDDING_MODEL_ID             = var.embedding_model_id
  })
}

module "queues" {
  source           = "../queues"
  name             = local.name
  alerts_topic_arn = module.observability.alerts_topic_arn
  queues = {
    for k, w in local.queued_workers : w.queue => { visibility_timeout_seconds = 6 * w.timeout }
  }
}

data "aws_iam_policy_document" "worker" {
  for_each = local.workers

  statement {
    sid       = "ReadSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = each.value.secrets
  }

  dynamic "statement" {
    for_each = length(each.value.sends_to) > 0 ? [1] : []
    content {
      sid       = "SendToQueues"
      actions   = ["sqs:SendMessage"]
      resources = [for q in each.value.sends_to : module.queues.arns[q]]
    }
  }

  dynamic "statement" {
    for_each = each.value.queue != null ? [1] : []
    content {
      sid       = "ConsumeOwnQueue"
      actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
      resources = [module.queues.arns[each.value.queue]]
    }
  }

  dynamic "statement" {
    for_each = length(each.value.content) > 0 ? [1] : []
    content {
      sid       = "ContentBucket"
      actions   = each.value.content
      resources = ["${module.content.bucket_arn}/items/*"]
    }
  }

  # Article image copies (letter-step at lock). ListBucket so a missing copy is a 404, not a 403.
  dynamic "statement" {
    for_each = each.value.images ? [1] : []
    content {
      sid       = "WriteImages"
      actions   = ["s3:GetObject", "s3:PutObject"]
      resources = ["${module.images.bucket_arn}/images/*"]
    }
  }

  dynamic "statement" {
    for_each = each.value.images ? [1] : []
    content {
      sid       = "ListImages"
      actions   = ["s3:ListBucket"]
      resources = [module.images.bucket_arn]
      condition {
        test     = "StringLike"
        variable = "s3:prefix"
        values   = ["images/*"]
      }
    }
  }

  # Only the embedding model (build plan §9).
  dynamic "statement" {
    for_each = each.value.bedrock ? [1] : []
    content {
      sid       = "EmbedWithBedrock"
      actions   = ["bedrock:InvokeModel"]
      resources = [local.embedding_model_arn]
    }
  }
}

module "worker" {
  source   = "../lambda_fn"
  for_each = local.workers

  name             = "${local.name}-${each.key}"
  description      = each.value.description
  artifact_name    = each.key
  artifacts_bucket = var.artifacts_bucket
  release          = var.release
  runtime          = var.lambda_runtime
  timeout_seconds  = each.value.timeout
  memory_mb        = each.value.memory
  vpc_config       = local.vpc_config
  policy_json      = data.aws_iam_policy_document.worker[each.key].json
  environment      = local.worker_env

  log_retention_days = var.log_retention_days
}

resource "aws_lambda_event_source_mapping" "worker" {
  for_each = local.queued_workers

  event_source_arn        = module.queues.arns[each.value.queue]
  function_name           = module.worker[each.key].function_arn
  batch_size              = each.value.batch_size
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = each.value.concurrency
  }
}

module "sweep_schedule" {
  source              = "../scheduler"
  name                = "${local.name}-sweep"
  target_function_arn = module.worker["sweep"].function_arn
  enabled             = var.sweep_enabled
}
