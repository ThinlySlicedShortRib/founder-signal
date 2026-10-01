module "stack" {
  source = "../../modules/stack"

  env              = "dev"
  release          = var.release
  artifacts_bucket = var.artifacts_bucket
  email_from       = var.email_from
  alert_email      = var.alert_email

  # Cheap NAT instance (~$7/mo) instead of a managed NAT gateway (~$37/mo).
  nat_mode = "fck-nat"

  db_multi_az              = false
  db_backup_retention_days = 1
  db_deletion_protection   = false
  db_skip_final_snapshot   = true
  db_enable_proxy          = false

  content_force_destroy = true

  secret_recovery_window_days = 0
  log_retention_days          = 14

  api_domain_name     = var.api_domain_name
  api_certificate_arn = var.api_certificate_arn
}
