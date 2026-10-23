#!/bin/sh
set -eu

fifo_attrs='FifoQueue=true,ContentBasedDeduplication=false'

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes "$fifo_attrs,MessageRetentionPeriod=1209600" >/dev/null

dlq_arn=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --output text)" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null

awslocal sqs create-queue --queue-name wallet-events.fifo --attributes "$fifo_attrs" >/dev/null
