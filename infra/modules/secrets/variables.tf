variable "env" {
  type = string
}

variable "recovery_window_days" {
  description = "0 deletes immediately (handy in dev); 7-30 for prod."
  type        = number
  default     = 7
}
