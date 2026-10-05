# Newsletters by email (docs/imports/README.md). Mail to <anything>@<domain> is received by SES
# in this region, saved to a private KMS-encrypted bucket, and announced on SNS → SQS, where the
# newsletter-inbound worker reads it, files it for its user and deletes it.
#
#   SES receipt rule (spam/virus scan, TLS required)
#     └─ S3 action: s3://<bucket>/inbound/<message id>   (SSE-KMS, expires after 7 days)
#          └─ notification (envelope recipients + SPF/DKIM/DMARC/spam/virus verdicts) → SNS → SQS → λ
#
# Why S3 + SNS rather than S3 event notifications or SES's Lambda action: SES's own notification
# carries the envelope recipient (a Gmail filter keeps the original To, so the headers don't say
# which address it was sent to) and the verdicts; the SNS action alone caps messages at 150 KB;
# and SQS gives retries and a DLQ, like every other pipeline step.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  rule_set   = "${var.name}-inbound"
  rule_name  = "${var.name}-newsletters"
  # Built from names (not the rule resource) so the policies SES needs can exist before the rule.
  rule_arn = "arn:aws:ses:${local.region}:${local.account_id}:receipt-rule-set/${local.rule_set}:receipt-rule/${local.rule_name}"
  prefix   = "inbound/"
}

# --- Domain identity (verification and DKIM, by three CNAMEs) ---------------------------

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain
}

# --- Encryption key: the mail bucket and the SNS topic ----------------------------------

data "aws_iam_policy_document" "key" {
  statement {
    sid       = "AccountAdmin"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  # SES writes to the bucket (SSE-KMS by default) and publishes to the encrypted topic. Scoped to this
  # account here; the bucket and topic policies below pin it to our receipt rule.
  statement {
    sid       = "SesReceiving"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }

  # SNS decrypts the topic's messages to deliver them to the queue.
  statement {
    sid       = "SnsDelivery"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "mail" {
  description             = "${var.name}: inbound newsletter mail (bucket and notifications)"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.key.json
}

resource "aws_kms_alias" "mail" {
  name          = "alias/${var.name}-inbound-mail"
  target_key_id = aws_kms_key.mail.key_id
}

# --- Raw mail bucket --------------------------------------------------------------------

resource "aws_s3_bucket" "mail" {
  bucket        = var.bucket_name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.mail.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "mail" {
  bucket                  = aws_s3_bucket.mail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "mail" {
  bucket = aws_s3_bucket.mail.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# The worker deletes each message once it's processed; this catches the rest.
resource "aws_s3_bucket_lifecycle_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id
  rule {
    id     = "expire-raw-mail"
    status = "Enabled"
    filter {}
    expiration {
      days = var.retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.mail.arn, "${aws_s3_bucket.mail.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Only SES, only for our receipt rule, only under inbound/.
  statement {
    sid       = "AllowSesPuts"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.mail.arn}/${local.prefix}*"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.rule_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "mail" {
  bucket = aws_s3_bucket.mail.id
  policy = data.aws_iam_policy_document.bucket.json
}

# --- Notifications: SES → SNS → SQS -----------------------------------------------------

resource "aws_sns_topic" "received" {
  name              = "${var.name}-inbound-mail"
  kms_master_key_id = aws_kms_key.mail.arn
}

data "aws_iam_policy_document" "topic" {
  statement {
    sid       = "AllowSesPublish"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.received.arn]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.rule_arn]
    }
  }
}

resource "aws_sns_topic_policy" "received" {
  arn    = aws_sns_topic.received.arn
  policy = data.aws_iam_policy_document.topic.json
}

data "aws_iam_policy_document" "queue" {
  statement {
    sid       = "AllowTopic"
    actions   = ["sqs:SendMessage"]
    resources = [var.queue_arn]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.received.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "inbound" {
  queue_url = var.queue_url
  policy    = data.aws_iam_policy_document.queue.json
}

# Raw delivery: the queue message is SES's notification JSON itself.
resource "aws_sns_topic_subscription" "queue" {
  topic_arn            = aws_sns_topic.received.arn
  protocol             = "sqs"
  endpoint             = var.queue_arn
  raw_message_delivery = true
  depends_on           = [aws_sqs_queue_policy.inbound]
}

# --- Receipt rules ----------------------------------------------------------------------
# A region has one active rule set. This takes that slot in the project's region.

resource "aws_ses_receipt_rule_set" "inbound" {
  rule_set_name = local.rule_set
}

resource "aws_ses_active_receipt_rule_set" "inbound" {
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
}

resource "aws_ses_receipt_rule" "newsletters" {
  name          = local.rule_name
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
  # The whole domain: which address belongs to whom is the worker's job (unknown ones are dropped there).
  recipients   = [var.domain]
  enabled      = true
  scan_enabled = true
  tls_policy   = "Require"

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.mail.id
    object_key_prefix = local.prefix
    topic_arn         = aws_sns_topic.received.arn
  }

  # SES checks it may write and publish when the rule is created.
  depends_on = [aws_s3_bucket_policy.mail, aws_sns_topic_policy.received, aws_kms_key.mail]
}
