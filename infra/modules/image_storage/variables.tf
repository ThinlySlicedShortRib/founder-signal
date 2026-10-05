variable "bucket_name" {
  type = string
}

variable "force_destroy" {
  description = "Allow destroying the bucket with objects in it (dev only)."
  type        = bool
  default     = false
}

variable "public_prefixes" {
  description = "Key prefixes CloudFront may read: piece images, and podcast episodes when that experiment is on."
  type        = list(string)
  default     = ["images"]
}
