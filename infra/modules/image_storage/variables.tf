variable "bucket_name" {
  type = string
}

variable "force_destroy" {
  description = "Allow destroying the bucket with objects in it (dev only)."
  type        = bool
  default     = false
}
