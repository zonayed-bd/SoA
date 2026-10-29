'use strict';

// Renders customer emails from order events. Pure functions, so the consumer
// side of the OrderPlaced contract can be tested without a broker or database.
const euro = (cents) => `€${(cents / 100).toFixed(2)}`;
const shortId = (orderId) => orderId.slice(0, 8).toUpperCase();

const REASONS = {
  OUT_OF_STOCK: 'one or more items went out of stock',
  PAYMENT_DECLINED: 'your payment was declined by the card issuer',
};

const TEMPLATES = {
  'order.placed.v1': (data, name) => ({
    template: 'order-received',
    subject: `We've received your order ${shortId(data.orderId)}`,
    body: `Hi ${name}, thanks for shopping with MaltaShop. Your order of ${data.items.length} item(s) totalling ${euro(data.totalCents)} is being processed.`,
  }),
  'order.confirmed.v1': (data, name) => ({
    template: 'order-confirmed',
    subject: `Order ${shortId(data.orderId)} is confirmed`,
    body: `Hi ${name}, your payment of ${euro(data.totalCents)} was successful and your order is being prepared for delivery.`,
  }),
  'order.rejected.v1': (data, name) => ({
    template: 'order-rejected',
    subject: `We couldn't complete order ${shortId(data.orderId)}`,
    body: `Hi ${name}, we're sorry: ${REASONS[data.reason] || 'something went wrong'}. You have not been charged.`,
  }),
};

function supports(type) {
  return Object.hasOwn(TEMPLATES, type);
}

function render(envelope, contact) {
  return TEMPLATES[envelope.type](envelope.data, contact.firstName);
}

// maria.borg@example.com -> m***@example.com (safe to log)
function maskEmail(email) {
  const [local, domain] = email.split('@');
  return `${local[0]}***@${domain}`;
}

module.exports = { supports, render, maskEmail };
