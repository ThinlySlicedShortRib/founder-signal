variable "name" {
  description = "Used for the API, the function, its role and log groups (e.g. founder-signal-dev-api)."
  type        = string
}

variable "artifact_name" {
  type    = string
  default = "api"
}

variable "artifacts_bucket" {
  type = string
}

variable "release" {
  type = string
}

variable "runtime" {
  type    = string
  default = "nodejs24.x"
}

variable "memory_mb" {
  type    = number
  default = 1024
}

variable "timeout_seconds" {
  description = "API Gateway caps integrations at 29s."
  type        = number
  default     = 29
}

variable "environment" {
  description = "Function env vars; BETTER_AUTH_URL is added by this module."
  type        = map(string)
  default     = {}
}

variable "vpc_config" {
  type = object({
    subnet_ids         = list(string)
    security_group_ids = list(string)
  })
  default = null
}

variable "policy_json" {
  type    = string
  default = null
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "throttle_rate" {
  description = "Steady-state requests per second across the API."
  type        = number
  default     = 50
}

variable "throttle_burst" {
  type    = number
  default = 100
}

variable "domain_name" {
  description = "Optional custom domain (e.g. api.example.com). Requires certificate_arn in the same region."
  type        = string
  default     = null
}

variable "certificate_arn" {
  type    = string
  default = null

  validation {
    condition     = var.domain_name == null || var.certificate_arn != null
    error_message = "certificate_arn is required when domain_name is set."
  }
}
