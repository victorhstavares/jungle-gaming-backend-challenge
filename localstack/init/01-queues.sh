#!/bin/sh
set -eu

fifo_attrs='FifoQueue=true,ContentBasedDeduplication=false'

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes "$fifo_attrs,MessageRetentionPeriod=1209600" >/dev/null

dlq_arn=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --output text)" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# Ten receives with backoff capped at 60s ride out a few minutes of database downtime before a message is parked.
redrive_policy="{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"10\\\"}"

awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"$redrive_policy\"}" >/dev/null

awslocal sqs create-queue --queue-name wallet-events.fifo --attributes "$fifo_attrs" >/dev/null
