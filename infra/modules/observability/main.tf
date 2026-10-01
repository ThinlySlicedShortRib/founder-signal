resource "aws_cloudwatch_log_group" "mobile" {
  name              = "/founder-signal/${var.env}/mobile"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_metric_filter" "mobile_errors" {
  name           = "founder-signal-${var.env}-mobile-errors"
  log_group_name = aws_cloudwatch_log_group.mobile.name
  pattern        = "{ $.level = \"error\" }"

  metric_transformation {
    name          = "MobileErrors"
    namespace     = "FounderSignal/${var.env}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_sns_topic" "alerts" {
  name = "founder-signal-${var.env}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email != null ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "mobile_errors" {
  alarm_name          = "founder-signal-${var.env}-mobile-errors"
  alarm_description   = "Mobile app reported more than ${var.mobile_error_threshold} errors in 15 minutes."
  namespace           = "FounderSignal/${var.env}"
  metric_name         = "MobileErrors"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = var.mobile_error_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
