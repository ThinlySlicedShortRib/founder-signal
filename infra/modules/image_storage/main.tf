# Piece images copied from articles, so letters don't depend on publishers'
# hotlinks staying up. The bucket is private; the app loads images from a
# CloudFront distribution that reads it through origin access control (OAC).
# CloudFront is global, so it needs nothing outside the project's Region.
# Stock photos stay hotlinked, as Unsplash's guidelines require.

resource "aws_s3_bucket" "images" {
  bucket        = var.bucket_name
  force_destroy = var.force_destroy
}

# SSE-S3: CloudFront reads it with no key policy to manage.
resource "aws_s3_bucket_server_side_encryption_configuration" "images" {
  bucket = aws_s3_bucket.images.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "images" {
  bucket                  = aws_s3_bucket.images.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "images" {
  bucket = aws_s3_bucket.images.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_cloudfront_origin_access_control" "images" {
  name                              = var.bucket_name
  description                       = "CloudFront reads ${var.bucket_name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# AWS's managed "CachingOptimized" policy: long TTLs, no cookies or query strings.
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "images" {
  enabled         = true
  comment         = "Founder Signal piece images (${var.bucket_name})"
  is_ipv6_enabled = true
  http_version    = "http2and3"
  # All edge locations, so Australia is served locally.
  price_class = "PriceClass_All"

  origin {
    origin_id                = "images"
    domain_name              = aws_s3_bucket.images.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.images.id
  }

  default_cache_behavior {
    target_origin_id       = "images"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "images" {
  statement {
    sid       = "CloudFrontReadsImages"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.images.arn}/images/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.images.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.images.arn, "${aws_s3_bucket.images.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "images" {
  bucket     = aws_s3_bucket.images.id
  policy     = data.aws_iam_policy_document.images.json
  depends_on = [aws_s3_bucket_public_access_block.images]
}
