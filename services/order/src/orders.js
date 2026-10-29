'use strict';

// Data access for the Order service (its own PostgreSQL database only).

async function loadPriceList(client, skus) {
  const { rows } = await client.query(
    'SELECT sku, name, unit_price_cents FROM product_prices WHERE sku = ANY($1::text[])',
    [skus],
  );
  return new Map(rows.map((r) => [r.sku, { name: r.name, unitPriceCents: r.unit_price_cents }]));
}

async function findByIdempotencyKey(client, key) {
  const { rows } = await client.query('SELECT id, request_hash FROM orders WHERE idempotency_key = $1', [key]);
  return rows[0];
}

async function insertOrder(client, order) {
  await client.query(
    `INSERT INTO orders (id, customer_id, status, currency, total_cents, vat_cents, payment_token,
                         idempotency_key, request_hash, correlation_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      order.id,
      order.customerId,
      order.status,
      order.currency,
      order.totalCents,
      order.vatCents,
      order.paymentToken,
      order.idempotencyKey,
      order.requestHash,
      order.correlationId,
      order.createdAt,
    ],
  );
  for (const item of order.items) {
    await client.query(
      'INSERT INTO order_items (order_id, sku, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)',
      [order.id, item.sku, item.quantity, item.unitPriceCents],
    );
  }
}

// Row lock: replies for the same order are applied one at a time.
async function lockOrder(client, id) {
  const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) return undefined;
  const items = await client.query('SELECT sku, quantity, unit_price_cents FROM order_items WHERE order_id = $1', [id]);
  return toOrder(rows[0], items.rows);
}

async function updateStatus(client, id, status, reason) {
  await client.query(
    `UPDATE orders SET status = $2, reason = $3, updated_at = now(),
            payment_token = CASE WHEN $2 IN ('CONFIRMED', 'REJECTED') THEN NULL ELSE payment_token END
      WHERE id = $1`,
    [id, status, reason || null],
  );
}

async function logStep(client, orderId, step, detail) {
  await client.query('INSERT INTO saga_log (order_id, step, detail) VALUES ($1, $2, $3)', [orderId, step, detail || null]);
}

async function getOrderView(db, id) {
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (!rows[0]) return undefined;
  const items = await db.query('SELECT sku, quantity, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY sku', [id]);
  const saga = await db.query('SELECT step, at FROM saga_log WHERE order_id = $1 ORDER BY id', [id]);
  const order = toOrder(rows[0], items.rows);
  return {
    orderId: order.id,
    customerId: order.customerId,
    status: order.status,
    reason: order.reason || undefined,
    items: order.items,
    totalCents: order.totalCents,
    vatCents: order.vatCents,
    currency: order.currency,
    createdAt: order.createdAt,
    saga: saga.rows.map((s) => ({ step: s.step, at: s.at.toISOString() })),
    links: { self: `/v1/orders/${order.id}` },
  };
}

function toOrder(row, itemRows) {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    reason: row.reason,
    currency: row.currency,
    totalCents: row.total_cents,
    vatCents: row.vat_cents,
    paymentToken: row.payment_token,
    correlationId: row.correlation_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    items: itemRows.map((i) => ({ sku: i.sku, quantity: i.quantity, unitPriceCents: i.unit_price_cents })),
  };
}

module.exports = { loadPriceList, findByIdempotencyKey, insertOrder, lockOrder, updateStatus, logStep, getOrderView };
