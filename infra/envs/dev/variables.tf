variable "region" {
  type    = string
  default = "ap-southeast-2"
}

variable "release" {
  description = "Git SHA of the Lambda bundles uploaded to the artifacts bucket."
  type        = string
}

variable "artifacts_bucket" {
  description = "From infra/bootstrap output artifacts_bucket."
  type        = string
}

variable "email_from" {
  description = "Sender address for sign-in codes and letters (must be SES-verified)."
  type        = string
}

variable "alert_email" {
  type    = string
  default = null
}

variable "api_domain_name" {
  type    = string
  default = null
}

variable "api_certificate_arn" {
  type    = string
  default = null
}

variable "google_oauth_client_id" {
  description = "Connect YouTube: the Google OAuth web client ID. Empty turns it off (docs/imports/README.md)."
  type        = string
  default     = ""
}

variable "inbound_email_domain" {
  description = "Newsletters by email: the receiving domain (e.g. in.example.com). Empty turns it off; see docs/imports/README.md for the DNS records."
  type        = string
  default     = ""
}
