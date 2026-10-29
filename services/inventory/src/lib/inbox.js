'use strict';

// Idempotent consumer ("inbox"). The id of every handled message is stored in the
// same transaction as the business change. A redelivered message hits the primary
// key, ON CONFLICT DO NOTHING inserts nothing, and the handler is skipped.
const INBOX_DDL = `
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id   uuid        NOT NULL,
  consumer     text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, consumer)
);
`;

async function alreadyProcessed(pool, messageId, consumer) {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM processed_messages WHERE message_id = $1 AND consumer = $2',
    [messageId, consumer],
  );
  return rowCount > 0;
}

async function withInbox(pool, envelope, consumer, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      'INSERT INTO processed_messages (message_id, consumer) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [envelope.id, consumer],
    );
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return { duplicate: true };
    }
    const result = await work(client);
    await client.query('COMMIT');
    return { duplicate: false, result };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { INBOX_DDL, withInbox, alreadyProcessed };
