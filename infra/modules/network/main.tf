data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
  # 10.20.0.0/16 -> public 10.20.0.0/24, 10.20.1.0/24; private 10.20.10.0/24, 10.20.11.0/24
  public_cidrs  = [for i in range(2) : cidrsubnet(var.cidr, 8, i)]
  private_cidrs = [for i in range(2) : cidrsubnet(var.cidr, 8, i + 10)]
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public-${local.azs[count.index]}", tier = "public" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = local.azs[count.index]
  tags              = { Name = "${var.name}-private-${local.azs[count.index]}", tier = "private" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One private route table per AZ so gateway mode can route each AZ to its own NAT.
resource "aws_route_table" "private" {
  count  = 2
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-private-${local.azs[count.index]}" }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# Free gateway endpoint: S3 traffic from private subnets skips the NAT.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id
  tags              = { Name = "${var.name}-s3" }
}

data "aws_region" "current" {}

# --- NAT: managed gateway -----------------------------------------------------

resource "aws_eip" "nat" {
  count  = var.nat_mode == "gateway" ? var.nat_gateway_count : 0
  domain = "vpc"
  tags   = { Name = "${var.name}-nat-${count.index}" }
}

resource "aws_nat_gateway" "this" {
  count         = var.nat_mode == "gateway" ? var.nat_gateway_count : 0
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "${var.name}-nat-${count.index}" }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route" "private_nat_gateway" {
  count                  = var.nat_mode == "gateway" ? 2 : 0
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  # With one NAT gateway both AZs share it; with two, each AZ uses its own.
  nat_gateway_id = aws_nat_gateway.this[min(count.index, var.nat_gateway_count - 1)].id
}

# --- NAT: fck-nat instance ----------------------------------------------------

module "fck_nat" {
  source  = "RaJiska/fck-nat/aws"
  version = "~> 1.3"
  count   = var.nat_mode == "fck-nat" ? 1 : 0

  name          = "${var.name}-fck-nat"
  vpc_id        = aws_vpc.this.id
  subnet_id     = aws_subnet.public[0].id
  instance_type = var.fck_nat_instance_type
  ha_mode       = true # ASG of one: a failed instance is replaced automatically

  update_route_tables = true
  route_tables_ids    = { for i, rt in aws_route_table.private : "private-${i}" => rt.id }
}

# --- Security groups ----------------------------------------------------------

resource "aws_security_group" "lambda" {
  name        = "${var.name}-lambda"
  description = "Lambdas running in the VPC"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_egress_rule" "lambda_all" {
  security_group_id = aws_security_group.lambda.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Postgres, reachable only from VPC Lambdas"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_lambda" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# RDS Proxy (when enabled) sits in the db SG and must reach the instance on 5432.
resource "aws_vpc_security_group_ingress_rule" "db_from_self" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "db_to_self" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
