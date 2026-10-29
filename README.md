# MaltaShop – place-order prototype

A small, runnable prototype of the **"place an order"** flow for MaltaShop, a
Maltese e-commerce company moving from a PHP monolith to a small set of
microservices. It was built for the Unit 5 case study (Service-Oriented
Architecture and Microservices Fundamentals) to test the proposed architecture
on a laptop before any money is spent on cloud infrastructure.

It shows four services that each own their own PostgreSQL database and keep an
order consistent **without a shared database or a distributed transaction**:

| Service | Responsibility | Owns (data store) | Talks via |
|---|---|---|---|
| `order-service` | REST API for orders; **saga orchestrator** | `orders` DB: orders, items, saga log, outbox, inbox | REST in, RabbitMQ out/in |
| `inventory-service` | Stock levels and reservations | `inventory` DB: stock, reservations, outbox, inbox | RabbitMQ |
| `payment-service` | Card authorisation through provider adapters, circuit breaker + failover | `payments` DB: payments, outbox, inbox | RabbitMQ |
| `notification-service` | Customer emails from order events | `notifications` DB: contacts, delivery log, inbox | RabbitMQ |

```
            POST /v1/orders (Idempotency-Key, X-Correlation-ID)
                     │
              ┌──────▼───────┐  outbox relay   ┌──────────────────────────┐
              │ order-service ├───────────────►│ RabbitMQ                 │
              │  (saga)       │◄───────────────┤ topic exchange           │
              └──────┬───────┘   replies       │ maltashop.events         │
                     │                          └──┬─────────┬─────────┬──┘
                  orders DB          cmd.inventory.*│  cmd.payment.*   │ evt.order.*
                                              ┌─────▼────┐ ┌──▼──────┐ ┌▼─────────────┐
                                              │inventory │ │payment  │ │notification  │
                                              └────┬─────┘ └───┬─────┘ └──────┬───────┘
                                              inventory DB  payments DB  notifications DB
```

## Run it

Prerequisites: Docker with Compose v2 (Docker Desktop 4.x or Docker Engine 24+).

```bash
docker compose up --build        # first run builds four images (about a minute)
```

The stack is ready when `docker compose ps` shows every container as `healthy`.
The Order API is published on `http://localhost:8080` and the RabbitMQ
management UI on `http://localhost:15672` (user `maltashop`, password
`maltashop-dev`). Both are bound to `127.0.0.1` only. If port 8080 is taken,
run `ORDER_HOST_PORT=18080 docker compose up --build`.

Run the end-to-end smoke test against the running stack:

```bash
./scripts/smoke-test.sh          # needs curl, jq and uuidgen
```

Stop and delete everything, including the databases: `docker compose down -v`.

## Try it

```bash
# Place an order (returns 202 Accepted; the saga finishes asynchronously)
curl -i -X POST localhost:8080/v1/orders \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-0001' \
  -H 'x-correlation-id: demo-corr-0001' \
  -d '{"customerId":"cust-1001","paymentToken":"tok_visa_approved",
       "items":[{"sku":"SKU-KETTLE-17","quantity":2},{"sku":"SKU-AIRFRYER-5L","quantity":1}]}'

# Follow it: PENDING -> AWAITING_PAYMENT -> CONFIRMED, with the saga steps
curl -s localhost:8080/v1/orders/<orderId> | jq

# Every service logged the same correlation id
docker compose logs --no-log-prefix | grep demo-corr-0001
```

| To see… | Do this |
|---|---|
| Compensation (stock released) | use `"paymentToken":"tok_declined_insufficient_funds"` |
| Out-of-stock rejection | order `SKU-LAPTOP-14` (stock is 0) |
| Idempotency | repeat the same POST: same `orderId`, header `idempotent-replayed: true`; same key with a different body returns `409` |
| Provider failover | `PSP_PRIMARY_SIMULATE_OUTAGE=true docker compose up -d payment-service`, then place orders: the circuit opens and `betapay` authorises them |
| Failure isolation | `docker compose stop notification-service`, place orders (they still confirm), then `docker compose start notification-service` and watch the backlog drain |

Seed data: products `SKU-TV55-OLED`, `SKU-AIRFRYER-5L`, `SKU-KETTLE-17`,
`SKU-ESPRESSO-01`, `SKU-LAPTOP-14`; customers `cust-1001`, `cust-1002`.

## How it stays consistent

* **Saga (orchestration).** `order-service/src/saga.js` is a pure state machine:
  reserve stock → authorise payment → confirm. If payment is declined, the
  compensating action releases the reserved stock and the order is rejected.
* **Transactional outbox.** State changes and outgoing messages are written in
  one local transaction (`chassis/outbox.js`); a relay publishes them with
  RabbitMQ publisher confirms. Delivery is at-least-once.
* **Idempotency everywhere.** `Idempotency-Key` on the REST API; an inbox table
  of processed message ids in every consumer (`chassis/inbox.js`); natural keys
  (one reservation and one payment per order); and the payment provider is
  called with idempotency key `order-<id>`.
* **Poison messages.** Quorum queues with `x-delivery-limit: 5` move a message
  that keeps failing to `<queue>.dlq` instead of blocking the queue.

## Message flow

| Routing key | Type | From → to |
|---|---|---|
| `cmd.inventory.reserve-stock` | `inventory.reserve-stock.v1` | Order → Inventory |
| `evt.inventory.stock-reserved` / `stock-rejected` | `inventory.stock-*.v1` | Inventory → Order |
| `cmd.payment.authorise` | `payment.authorise.v1` | Order → Payment |
| `evt.payment.authorised` / `failed` | `payment.*.v1` | Payment → Order |
| `cmd.inventory.release-stock` | `inventory.release-stock.v1` | Order → Inventory (compensation) |
| `evt.order.placed` / `confirmed` / `rejected` | `order.*.v1` | Order → Notification (and any future subscriber, e.g. Recommendations) |

Messages use a CloudEvents-style JSON envelope (`specversion`, `id`, `type`,
`source`, `time`, `subject`, `correlationid`, `data`).

## Configuration (environment variables)

All configuration comes from environment variables (12-factor). Defaults in
`docker-compose.yml` are for local development only; copy `.env.example` to
`.env` to override them.

| Variable | Used by | Purpose | Local default |
|---|---|---|---|
| `DATABASE_URL` | all services | Connection string of the service's own database | set per service in compose |
| `AMQP_URL` | all services | RabbitMQ connection | `amqp://maltashop:…@rabbitmq:5672` |
| `PORT` | all services | HTTP port inside the container | `3000` |
| `LOG_LEVEL` | all services | `debug`, `info`, `warn`, `error` | `info` |
| `APP_ENV` | all services | Environment name written on every log line | `local` |
| `SERVICE_VERSION` | all services | Version written on every log line | `local` (CI sets the git SHA) |
| `OUTBOX_POLL_MS` | order, inventory, payment | Outbox relay polling interval | `250` |
| `PSP_TIMEOUT_MS` | payment | Timeout for a provider call before the breaker counts a failure | `2000` |
| `PSP_PRIMARY_SIMULATE_OUTAGE` | payment | `true` makes the primary provider fail (failover demo) | `false` |
| `ORDER_HOST_PORT` | compose | Host port for the Order API | `8080` |
| `ORDER_IMAGE`, `ORDER_VERSION` | compose | Run an already-built Order image (used by CI) | local build |
| `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `*_DB_PASSWORD` | compose | Development credentials | see `.env.example` |

## Tests and CI

| Level | Where | Command |
|---|---|---|
| Unit | `services/*/test/unit` | `npm run test:unit` in a service folder |
| Contract (consumer-driven) | `contracts/`, `services/notification/test/contract` (consumer), `services/order/test/contract` (provider) | `npm run test:contract` |
| Integration / smoke | whole stack in Docker | `./scripts/smoke-test.sh` |

`.github/workflows/order-service.yml` runs on every pull request and push to
`main`: lint + unit + contract tests and a gitleaks secret scan in parallel →
build the image once (tagged with the commit SHA) and scan it with Trivy →
start the stack with that image and run the smoke tests → on `main`, push the
same image to GHCR.

## Repository layout

```
chassis/            shared logger, broker, outbox, inbox and runtime modules
services/<name>/    one folder per service: src/, test/, Dockerfile, package.json
contracts/          consumer-driven message contracts
scripts/            smoke test and chassis sync
docs/adr/           architecture decision records
.github/            CI workflow, CODEOWNERS, pull request template
```

The chassis modules are copied into each service by `scripts/sync-chassis.sh`
(CI fails if a copy drifts) so every service builds and ships on its own. In
production they would be a versioned internal npm package.

## Working on it

Trunk-based development: short-lived branches (less than a day), a pull
request with at least one review (`.github/CODEOWNERS`), and a green pipeline
before merging to `main`. Unfinished work is hidden behind feature flags rather
than long-lived branches. Architecture decisions are recorded in `docs/adr/`.

## Known limitations (prototype, not production)

* No API gateway or authentication in front of the Order API.
* Correlation ids only; no OpenTelemetry tracing or metrics yet.
* No saga timeout: an order stays `AWAITING_PAYMENT` if Payment never replies.
* Failed messages are requeued immediately (no back-off) before going to the DLQ.
* Schema migrations run at start-up; production would run them as a one-off job.
* One RabbitMQ node and simulated payment providers.
* All services sit in one repository so the assessment has a single link;
  production would use one repository per service.
