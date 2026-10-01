output "better_auth_secret_arn" {
  value = aws_secretsmanager_secret.better_auth.arn
}

output "anthropic_api_key_secret_arn" {
  value = aws_secretsmanager_secret.anthropic.arn
}

output "youtube_api_key_secret_arn" {
  value = aws_secretsmanager_secret.youtube.arn
}

output "supadata_api_key_secret_arn" {
  value = aws_secretsmanager_secret.supadata.arn
}
