output "api_endpoint" {
  description = "Default execute-api URL."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "public_url" {
  description = "Custom domain URL if set, else the execute-api URL. Also passed to the function as BETTER_AUTH_URL."
  value       = local.public_url
}

output "function_name" {
  value = module.fn.function_name
}

output "role_name" {
  value = module.fn.role_name
}

output "regional_domain_target" {
  description = "Point a DNS alias/CNAME for domain_name here."
  value       = var.domain_name != null ? aws_apigatewayv2_domain_name.this[0].domain_name_configuration[0].target_domain_name : null
}
