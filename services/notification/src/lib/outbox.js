'use strict';

// Transactional outbox. Business code never publishes to the broker directly:
// it writes the message into the `outbox` table inside the same local database
// transaction as the state change, so "save the order" and "announce it" either
// both happen or neither does. A relay then publishes unsent rows.
const { randomUUID } = require('node:crypto');

const OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS outbox (
  seq          bigserial   PRIMARY KEY,
  id           uuid        NOT NULL UNIQUE,
  routing_key  text        NOT NULL,
  envelope     jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (seq) WHERE published_at IS NULL;
`;

// CloudEvents-style envelope; `correlationid` is a CloudEvents extension attribute.
function buildEnvelope({ source, type, subject, correlationId, data }) {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source,
    type,
    subject,
    time: new Date().toISOString(),
    correlationid: correlationId,
    datacontenttype: 'application/json',
    data,
  };
}

async function enqueue(client, { source, routingKey, type, subject, correlationId, data }) {
  const envelope = buildEnvelope({ source, type, subject, correlationId, data });
  await client.query('INSERT INTO outbox (id, routing_key, envelope) VALUES ($1, $2, $3)', [
    envelope.id,
    routingKey,
    envelope,
  ]);
  return envelope;
}

// Polls for unpublished rows. FOR UPDATE SKIP LOCKED lets several replicas run the
// relay at once without publishing the same row twice in parallel. Delivery is
// at-least-once (a crash after publish but before COMMIT re-sends the row), so
// every consumer must be idempotent.
function startRelay({ pool, broker, log, intervalMs = 250, batchSize = 50 }) {
  let timer;
  let stopped = false;
  let inFlight = Promise.resolve();

  async function tick() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, routing_key, envelope FROM outbox
          WHERE published_at IS NULL ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      for (const row of rows) {
        await broker.publish(row.routing_key, row.envelope);
        log.info(
          {
            event: 'outbox.published',
            correlation_id: row.envelope.correlationid,
            message_id: row.id,
            message_type: row.envelope.type,
            routing_key: row.routing_key,
          },
          `published ${row.envelope.type}`,
        );
      }
      if (rows.length > 0) {
        await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error({ event: 'outbox.relay.failed', err: err.message }, 'outbox relay failed, will retry');
    } finally {
      client.release();
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = tick().finally(schedule);
    }, intervalMs);
  }

  schedule();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}

module.exports = { OUTBOX_DDL, buildEnvelope, enqueue, startRelay };
