output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "github_deploy_role_arn" {
  value = var.enable_github_oidc ? aws_iam_role.github_deploy[0].arn : null
}
