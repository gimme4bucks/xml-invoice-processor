#!/bin/sh
# Diagnostic: queue state while the T5 process is still alive and after it exits.
docker exec spike-rmq-a rabbitmqctl -q list_queues name messages_ready messages_unacknowledged consumers | grep documents.process
docker exec spike-rmq-a rabbitmqctl -q list_channels connection number consumer_count messages_unacknowledged prefetch_count
