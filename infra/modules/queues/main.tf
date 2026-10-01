# One SQS queue + DLQ per pipeline step (build plan §4, `queues`).
# Messages that fail max_receive_count times land in the DLQ, and any DLQ depth alarms.

resource "aws_sqs_queue" "dlq" {
  for_each = var.queues

  name                      = "${var.name}-${each.key}-dlq"
  message_retention_seconds = 14 * 24 * 3600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "this" {
  for_each = var.queues

  name = "${var.name}-${each.key}"
  # AWS guidance: at least 6x the consumer's timeout, so a slow batch isn't redelivered mid-flight.
  visibility_timeout_seconds = each.value.visibility_timeout_seconds
  message_retention_seconds  = 4 * 24 * 3600
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = each.value.max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  for_each  = var.queues
  queue_url = aws_sqs_queue.dlq[each.key].id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.this[each.key].arn]
  })
}

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  for_each = var.queues

  alarm_name          = "${var.name}-${each.key}-dlq-not-empty"
  alarm_description   = "Messages in the ${each.key} DLQ: a pipeline step failed after all its retries."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dlq[each.key].name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alerts_topic_arn]
  ok_actions          = [var.alerts_topic_arn]
}
