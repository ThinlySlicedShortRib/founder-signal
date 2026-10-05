variable "name" {
  description = "Prefix, e.g. founder-signal-dev."
  type        = string
}

variable "domain" {
  description = "The receiving domain users' addresses are on, e.g. in.example.com. Its MX must point at inbound-smtp.<region>.amazonaws.com."
  type        = string
}

variable "bucket_name" {
  type = string
}

variable "queue_arn" {
  description = "The newsletter-inbound SQS queue that SES's notifications are delivered to."
  type        = string
}

variable "queue_url" {
  type = string
}

variable "retention_days" {
  description = "Raw messages are deleted once processed; anything left (failures) expires after this many days."
  type        = number
  default     = 7
}

variable "force_destroy" {
  type    = bool
  default = false
}
