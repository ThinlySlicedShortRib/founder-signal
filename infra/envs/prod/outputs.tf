output "api_endpoint" {
  value = module.stack.api_endpoint
}

output "api_public_url" {
  value = module.stack.api_public_url
}

output "api_function_name" {
  value = module.stack.api_function_name
}

output "migrate_function_name" {
  value = module.stack.migrate_function_name
}

output "db_endpoint" {
  value = module.stack.db_endpoint
}

output "db_secret_arn" {
  value = module.stack.db_secret_arn
}

output "better_auth_secret_arn" {
  value = module.stack.better_auth_secret_arn
}

output "anthropic_api_key_secret_arn" {
  value = module.stack.anthropic_api_key_secret_arn
}

output "mobile_log_group" {
  value = module.stack.mobile_log_group
}

output "alerts_topic_arn" {
  value = module.stack.alerts_topic_arn
}

output "worker_function_names" {
  value = module.stack.worker_function_names
}

output "queue_urls" {
  value = module.stack.queue_urls
}

output "content_bucket" {
  value = module.stack.content_bucket
}

output "youtube_api_key_secret_arn" {
  value = module.stack.youtube_api_key_secret_arn
}

output "supadata_api_key_secret_arn" {
  value = module.stack.supadata_api_key_secret_arn
}

output "images_bucket" {
  value = module.stack.images_bucket
}

output "images_base_url" {
  value = module.stack.images_base_url
}

output "inbound_email_dns_records" {
  description = "Newsletters by email: add these at your DNS provider."
  value       = module.stack.inbound_email_dns_records
}
