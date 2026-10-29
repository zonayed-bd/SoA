'use strict';

// Stock commands. Each runs inside the caller's transaction (see handlers.js).

// Checks every line against the locked stock rows. Pure, so it is unit-tested.
function findShortages(items, stockBySku) {
  return items
    .map(({ sku, quantity }) => ({ sku, requested: quantity, available: stockBySku.get(sku) ?? 0 }))
    .filter((line) => line.available < line.requested);
}

async function reserve(client, orderId, items) {
  const existing = await client.query('SELECT status FROM reservations WHERE order_id = $1', [orderId]);
  if (existing.rows[0]) return { outcome: existing.rows[0].status === 'REJECTED' ? 'rejected' : 'reserved', repeat: true };

  // Lock the rows in a fixed order (by sku) so concurrent orders cannot deadlock.
  const skus = [...new Set(items.map((i) => i.sku))].sort();
  const { rows } = await client.query(
    'SELECT sku, available FROM stock WHERE sku = ANY($1::text[]) ORDER BY sku FOR UPDATE',
    [skus],
  );
  const shortages = findShortages(items, new Map(rows.map((r) => [r.sku, r.available])));

  if (shortages.length > 0) {
    await client.query("INSERT INTO reservations (order_id, items, status) VALUES ($1, $2, 'REJECTED')", [
      orderId,
      JSON.stringify(items),
    ]);
    return { outcome: 'rejected', shortages };
  }
  for (const { sku, quantity } of items) {
    await client.query('UPDATE stock SET available = available - $2, updated_at = now() WHERE sku = $1', [sku, quantity]);
  }
  await client.query("INSERT INTO reservations (order_id, items, status) VALUES ($1, $2, 'RESERVED')", [
    orderId,
    JSON.stringify(items),
  ]);
  return { outcome: 'reserved' };
}

// Compensating action. Safe to repeat: only a RESERVED reservation gives stock back.
async function release(client, orderId) {
  const { rows } = await client.query('SELECT items, status FROM reservations WHERE order_id = $1 FOR UPDATE', [orderId]);
  const reservation = rows[0];
  if (!reservation || reservation.status !== 'RESERVED') return { released: false, status: reservation?.status ?? 'NONE' };
  for (const { sku, quantity } of reservation.items) {
    await client.query('UPDATE stock SET available = available + $2, updated_at = now() WHERE sku = $1', [sku, quantity]);
  }
  await client.query("UPDATE reservations SET status = 'RELEASED', updated_at = now() WHERE order_id = $1", [orderId]);
  return { released: true };
}

async function commit(client, orderId) {
  const { rowCount } = await client.query(
    "UPDATE reservations SET status = 'COMMITTED', updated_at = now() WHERE order_id = $1 AND status = 'RESERVED'",
    [orderId],
  );
  return { committed: rowCount === 1 };
}

module.exports = { findShortages, reserve, release, commit };
