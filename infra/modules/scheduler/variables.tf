variable "name" {
  description = "Schedule name, e.g. founder-signal-dev-sweep."
  type        = string
}

variable "target_function_arn" {
  type = string
}

variable "schedule_expression" {
  type    = string
  default = "rate(5 minutes)"
}

variable "enabled" {
  type    = bool
  default = true
}
