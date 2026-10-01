output "address" {
  description = "Instance hostname."
  value       = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "db_name" {
  value = aws_db_instance.this.db_name
}

output "master_secret_arn" {
  description = "RDS-managed secret with JSON {username, password}."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "proxy_endpoint" {
  value = var.enable_proxy ? aws_db_proxy.this[0].endpoint : null
}

output "connect_host" {
  description = "Host the app should use: the proxy when enabled, otherwise the instance."
  value       = var.enable_proxy ? aws_db_proxy.this[0].endpoint : aws_db_instance.this.address
}
