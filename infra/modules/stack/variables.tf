variable "env" {
  type = string
}

variable "release" {
  description = "Git SHA; Lambda zips are read from s3://<artifacts_bucket>/<release>/<name>.zip"
  type        = string
}

variable "artifacts_bucket" {
  type = string
}

variable "lambda_runtime" {
  type    = string
  default = "nodejs24.x"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "nat_mode" {
  type = string
}

variable "nat_gateway_count" {
  type    = number
  default = 1
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_multi_az" {
  type = bool
}

variable "db_backup_retention_days" {
  type = number
}

variable "db_deletion_protection" {
  type = bool
}

variable "db_skip_final_snapshot" {
  type = bool
}

variable "db_performance_insights" {
  type    = bool
  default = false
}

variable "db_enable_proxy" {
  type    = bool
  default = false
}

variable "secret_recovery_window_days" {
  type    = number
  default = 7
}

variable "email_from" {
  type = string
}

variable "alert_email" {
  type    = string
  default = null
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "api_domain_name" {
  type    = string
  default = null
}

variable "api_certificate_arn" {
  type    = string
  default = null
}

variable "enrichment_enabled" {
  description = "Enrich items with Claude (Message Batches) and Bedrock embeddings. Needs the Anthropic key set and Bedrock model access."
  type        = bool
  default     = true
}

variable "embedding_model_id" {
  type    = string
  default = "amazon.titan-embed-text-v2:0"
}

variable "sweep_enabled" {
  description = "Turn the 5-minute sweep off to pause all background work."
  type        = bool
  default     = true
}

variable "content_force_destroy" {
  description = "Allow `terraform destroy` to delete the content bucket with objects in it (dev only)."
  type        = bool
  default     = false
}
