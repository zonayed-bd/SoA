# ADR 0001: Managed RabbitMQ as the message broker

* Status: Accepted
* Deciders: Lead Solutions Architect, platform team, checkout team, data team
* Date: 2026-10-29

## Context

MaltaShop's new services must exchange commands and events (the place-order
saga, OrderPlaced for Notification and the AI Recommendation service) without
temporal coupling, so that a slow or failed consumer never slows checkout.
The team has two operations staff, no experience of running distributed
infrastructure, and a limited tooling budget. Expected volume is modest:
about 40 events per second at normal peak and about 400 per second at a
ten-times sale peak. The monolith (PHP) must be able to publish events during
the Strangler Fig migration, and the data team consumes in Python.

## Decision

Use **RabbitMQ 4.x as a managed service** (Amazon MQ for RabbitMQ, three-node
cluster in eu-south-1) with one topic exchange, one quorum queue per consuming
service with a delivery limit and a dead-letter queue, publisher confirms,
manual acknowledgements, a CloudEvents-style envelope and the transactional
outbox pattern. The Recommendation queue is length-limited (`x-max-length`,
`drop-head`) so that a stalled AI consumer can never build back-pressure on
publishers. Every event is also archived to S3 so the data team can replay
history for model training.

## Alternatives considered

| Criterion (weight) | RabbitMQ (managed) | Kafka (Amazon MSK / Confluent) | Vendor ESB | Amazon SNS + SQS |
|---|---|---|---|---|
| Operational effort for 2 ops staff (30%) | Low | Medium–high (partitions, offsets, rebalancing) | High, specialist skills | Very low |
| Delivery guarantees, DLQ, routing (20%) | Strong | Strong (ordering per key) | Strong | Good, simpler routing |
| Runs identically on a laptop / CI (15%) | Yes (container) | Heavier | No | Emulator only |
| Cost at MaltaShop's volume (15%) | Low | Higher fixed cost | Licence + consultancy | Lowest |
| Replay for the AI team (10%) | Via S3 archive | Native | No | No |
| Lock-in (10%) | Low (AMQP, open source) | Low | High | High (AWS-specific) |

Kafka was rejected *for now*: its strengths (very high throughput, native
replay) are not needed at about 400 events per second, and it costs more to run
and to learn. The ESB was rejected because it re-centralises logic and
releases in a "smart pipe" that becomes a bottleneck and a single point of
failure. SNS/SQS was the closest runner-up but fails dev/prod parity and ties
messaging semantics to one cloud.

## Consequences

* Positive: a small, well-understood toolset; local and CI environments match
  production; mature client libraries in PHP, Node.js and Python.
* Negative / technical debt accepted: no native long-term replay (mitigated by
  the S3 archive); a throughput ceiling far above current needs; RabbitMQ memory
  alarms can block publishers if queues grow without limit (mitigated by queue
  length limits and queue-depth alerts).
* Revisit when: sustained traffic exceeds ~5,000 events/s, more than ~10
  consumer groups need replay, or the data team needs stream processing. The
  outbox relay is the only code that talks to the broker, which keeps a later
  move to Kafka contained.
