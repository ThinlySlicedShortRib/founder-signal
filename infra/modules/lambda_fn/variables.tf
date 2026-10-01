variable "name" {
  description = "Function name, e.g. founder-signal-dev-api. Also used for the role and log group."
  type        = string
}

variable "description" {
  type    = string
  default = null
}

variable "artifact_name" {
  description = "Zip name inside the release folder: s3://<bucket>/<release>/<artifact_name>.zip"
  type        = string
}

variable "artifacts_bucket" {
  type = string
}

variable "release" {
  description = "Release folder in the artifacts bucket (git SHA)."
  type        = string
}

variable "runtime" {
  type    = string
  default = "nodejs24.x"
}

variable "handler" {
  type    = string
  default = "index.handler"
}

variable "memory_mb" {
  type    = number
  default = 512
}

variable "timeout_seconds" {
  type    = number
  default = 30
}

variable "environment" {
  type    = map(string)
  default = {}
}

variable "vpc_config" {
  description = "Set to run inside the VPC; null runs outside it."
  type = object({
    subnet_ids         = list(string)
    security_group_ids = list(string)
  })
  default = null
}

variable "policy_json" {
  description = "Extra inline IAM policy for the function role."
  type        = string
  default     = null
}

variable "log_retention_days" {
  type    = number
  default = 30
}
