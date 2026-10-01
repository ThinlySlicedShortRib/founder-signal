variable "name" {
  description = "Name prefix, e.g. founder-signal-dev."
  type        = string
}

variable "cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "nat_mode" {
  description = "\"fck-nat\" (cheap NAT instance, dev) or \"gateway\" (managed NAT gateway, prod)."
  type        = string
  default     = "fck-nat"

  validation {
    condition     = contains(["fck-nat", "gateway"], var.nat_mode)
    error_message = "nat_mode must be \"fck-nat\" or \"gateway\"."
  }
}

variable "nat_gateway_count" {
  description = "Managed NAT gateways when nat_mode = gateway: 1 (shared) or 2 (one per AZ)."
  type        = number
  default     = 1

  validation {
    condition     = contains([1, 2], var.nat_gateway_count)
    error_message = "nat_gateway_count must be 1 or 2."
  }
}

variable "fck_nat_instance_type" {
  type    = string
  default = "t4g.nano"
}
