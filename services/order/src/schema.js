'use strict';

const { OUTBOX_DDL } = require('./lib/outbox');
const { INBOX_DDL } = require('./lib/inbox');

// The Order service's private database. No other service may read these tables.
// product_prices is a local read model of catalogue prices (in production kept
// up to date from catalogue.price-changed events).
module.exports = `
CREATE TABLE IF NOT EXISTS product_prices (
  sku              text    PRIMARY KEY,
  name             text    NOT NULL,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id              uuid        PRIMARY KEY,
  customer_id     text        NOT NULL,
  status          text        NOT NULL,
  reason          text,
  currency        char(3)     NOT NULL DEFAULT 'EUR',
  total_cents     integer     NOT NULL,
  vat_cents       integer     NOT NULL,
  payment_token   text,
  idempotency_key text        NOT NULL UNIQUE,
  request_hash    text        NOT NULL,
  correlation_id  text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id         uuid    NOT NULL REFERENCES orders(id),
  sku              text    NOT NULL,
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL,
  PRIMARY KEY (order_id, sku)
);

CREATE TABLE IF NOT EXISTS saga_log (
  id       bigserial   PRIMARY KEY,
  order_id uuid        NOT NULL REFERENCES orders(id),
  step     text        NOT NULL,
  detail   jsonb,
  at       timestamptz NOT NULL DEFAULT clock_timestamp()
);

${OUTBOX_DDL}
${INBOX_DDL}

INSERT INTO product_prices (sku, name, unit_price_cents) VALUES
  ('SKU-TV55-OLED',    '55-inch OLED television',  129900),
  ('SKU-AIRFRYER-5L',  '5-litre air fryer',          8999),
  ('SKU-KETTLE-17',    '1.7-litre kettle',           2999),
  ('SKU-ESPRESSO-01',  'Espresso machine',          24900),
  ('SKU-LAPTOP-14',    '14-inch laptop',            89900)
ON CONFLICT (sku) DO NOTHING;
`;
