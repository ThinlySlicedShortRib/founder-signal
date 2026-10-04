resource "aws_secretsmanager_secret" "better_auth" {
  name                    = "founder-signal/${var.env}/better-auth-secret"
  description             = "Better Auth signing/encryption secret"
  recovery_window_in_days = var.recovery_window_days
}

resource "random_password" "better_auth" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret_version" "better_auth" {
  secret_id     = aws_secretsmanager_secret.better_auth.id
  secret_string = random_password.better_auth.result
}

# Value is set by hand (never stored in Terraform state):
#   aws secretsmanager put-secret-value \
#     --secret-id founder-signal/<env>/anthropic-api-key --secret-string 'sk-ant-...'
resource "aws_secretsmanager_secret" "anthropic" {
  name                    = "founder-signal/${var.env}/anthropic-api-key"
  description             = "Anthropic API key (set manually)"
  recovery_window_in_days = var.recovery_window_days
}

# Optional integrations; values set by hand like the Anthropic key. Until a
# value is set, the app treats the integration as off (YouTube links are
# refused; videos are saved without a transcript).
resource "aws_secretsmanager_secret" "youtube" {
  name                    = "founder-signal/${var.env}/youtube-api-key"
  description             = "YouTube Data API v3 key (set manually)"
  recovery_window_in_days = var.recovery_window_days
}

resource "aws_secretsmanager_secret" "supadata" {
  name                    = "founder-signal/${var.env}/supadata-api-key"
  description             = "Supadata transcript API key (set manually)"
  recovery_window_in_days = var.recovery_window_days
}

# Stock photos for pieces without a lead image. Until set, those pieces have no picture.
resource "aws_secretsmanager_secret" "unsplash" {
  name                    = "founder-signal/${var.env}/unsplash-access-key"
  description             = "Unsplash API access key (set manually)"
  recovery_window_in_days = var.recovery_window_days
}
