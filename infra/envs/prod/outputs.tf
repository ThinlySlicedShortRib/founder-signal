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
