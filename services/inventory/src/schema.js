'use strict';

const { OUTBOX_DDL } = require('./lib/outbox');
const { INBOX_DDL } = require('./lib/inbox');

// Inventory owns stock levels and reservations. One reservation per order
// (primary key) is the natural idempotency key for reserve/release.
module.exports = `
CREATE TABLE IF NOT EXISTS stock (
  sku        text        PRIMARY KEY,
  available  integer     NOT NULL CHECK (available >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  order_id   uuid        PRIMARY KEY,
  items      jsonb       NOT NULL,
  status     text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

${OUTBOX_DDL}
${INBOX_DDL}

INSERT INTO stock (sku, available) VALUES
  ('SKU-TV55-OLED',    25),
  ('SKU-AIRFRYER-5L',  40),
  ('SKU-KETTLE-17',   100),
  ('SKU-ESPRESSO-01',  10),
  ('SKU-LAPTOP-14',     0)
ON CONFLICT (sku) DO NOTHING;
`;
