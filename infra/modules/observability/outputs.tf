output "mobile_log_group_name" {
  value = aws_cloudwatch_log_group.mobile.name
}

output "mobile_log_group_arn" {
  value = aws_cloudwatch_log_group.mobile.arn
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
