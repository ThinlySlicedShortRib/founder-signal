module "stack" {
  source = "../../modules/stack"

  env              = "prod"
  release          = var.release
  artifacts_bucket = var.artifacts_bucket
  email_from       = var.email_from
  alert_email      = var.alert_email

  nat_mode          = "gateway"
  nat_gateway_count = var.nat_gateway_count

  db_multi_az              = true
  db_backup_retention_days = 7
  db_deletion_protection   = true
  db_skip_final_snapshot   = false
  db_performance_insights  = false # PI is being replaced by CloudWatch Database Insights; enable deliberately
  db_enable_proxy          = var.db_enable_proxy

  secret_recovery_window_days = 30
  log_retention_days          = 90

  api_domain_name     = var.api_domain_name
  api_certificate_arn = var.api_certificate_arn
}
