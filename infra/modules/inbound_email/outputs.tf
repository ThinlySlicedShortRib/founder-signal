output "bucket_name" {
  value = aws_s3_bucket.mail.id
}

output "bucket_arn" {
  value = aws_s3_bucket.mail.arn
}

output "kms_key_arn" {
  value = aws_kms_key.mail.arn
}

output "object_prefix" {
  value = local.prefix
}

# What to add at your DNS provider (docs/imports/README.md, "DNS").
output "dns_records" {
  value = concat(
    [{
      type    = "MX"
      name    = var.domain
      value   = "10 inbound-smtp.${local.region}.amazonaws.com"
      purpose = "Deliver mail for the domain to SES in ${local.region}"
    }],
    [for token in aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens : {
      type    = "CNAME"
      name    = "${token}._domainkey.${var.domain}"
      value   = "${token}.dkim.amazonses.com"
      purpose = "Verifies the domain with SES (Easy DKIM)"
    }],
  )
}
