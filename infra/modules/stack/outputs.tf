output "api_endpoint" {
  value = module.api.api_endpoint
}

output "api_public_url" {
  value = module.api.public_url
}

output "api_function_name" {
  value = module.api.function_name
}

output "migrate_function_name" {
  value = module.migrate.function_name
}

output "db_endpoint" {
  value = module.database.connect_host
}

output "db_secret_arn" {
  value = module.database.master_secret_arn
}

output "better_auth_secret_arn" {
  value = module.secrets.better_auth_secret_arn
}

output "anthropic_api_key_secret_arn" {
  value = module.secrets.anthropic_api_key_secret_arn
}

output "mobile_log_group" {
  value = module.observability.mobile_log_group_name
}

output "alerts_topic_arn" {
  value = module.observability.alerts_topic_arn
}

output "worker_function_names" {
  value = { for k, w in module.worker : k => w.function_name }
}

output "queue_urls" {
  value = module.queues.urls
}

output "content_bucket" {
  value = module.content.bucket_name
}

output "youtube_api_key_secret_arn" {
  value = module.secrets.youtube_api_key_secret_arn
}

output "supadata_api_key_secret_arn" {
  value = module.secrets.supadata_api_key_secret_arn
}

output "images_bucket" {
  value = module.images.bucket_name
}

output "images_base_url" {
  value = module.images.base_url
}

output "inbound_mail_bucket" {
  value = local.inbound_enabled ? module.inbound_email[0].bucket_name : null
}

output "inbound_email_dns_records" {
  description = "Newsletters by email: the records to add at your DNS provider (empty when inbound_email_domain isn't set)."
  value       = local.inbound_enabled ? module.inbound_email[0].dns_records : []
}
