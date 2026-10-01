variable "name" {
  description = "Prefix, e.g. founder-signal-dev."
  type        = string
}

variable "queues" {
  description = "Queue short name => settings."
  type = map(object({
    visibility_timeout_seconds = number
    max_receive_count          = optional(number, 3)
  }))
}

variable "alerts_topic_arn" {
  type = string
}
