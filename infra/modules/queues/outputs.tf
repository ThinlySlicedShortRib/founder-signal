output "urls" {
  value = { for k, q in aws_sqs_queue.this : k => q.url }
}

output "arns" {
  value = { for k, q in aws_sqs_queue.this : k => q.arn }
}

output "dlq_arns" {
  value = { for k, q in aws_sqs_queue.dlq : k => q.arn }
}
