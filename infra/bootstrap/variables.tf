variable "env" {
  description = "Environment this account hosts (dev or prod)."
  type        = string
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "artifact_retention_days" {
  description = "Days to keep Lambda zips (current and noncurrent versions)."
  type        = number
  default     = 90
}

variable "enable_github_oidc" {
  type    = bool
  default = false
}

variable "github_repo" {
  description = "owner/repo allowed to assume the deploy role."
  type        = string
  default     = ""

  validation {
    condition     = !var.enable_github_oidc || length(var.github_repo) > 0
    error_message = "github_repo is required when enable_github_oidc is true."
  }
}
