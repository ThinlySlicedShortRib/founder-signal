output "better_auth_secret_arn" {
  value = aws_secretsmanager_secret.better_auth.arn
}

output "anthropic_api_key_secret_arn" {
  value = aws_secretsmanager_secret.anthropic.arn
}
