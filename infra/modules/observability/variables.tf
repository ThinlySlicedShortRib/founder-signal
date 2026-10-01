variable "env" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "mobile_error_threshold" {
  type    = number
  default = 10
}

variable "alert_email" {
  description = "Email subscribed to the alerts topic (AWS sends a confirmation link). null = no subscription."
  type        = string
  default     = null
}
