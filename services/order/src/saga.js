'use strict';

// Place-order saga, orchestrated by the Order service. This module is a pure
// state machine: given the order's current status and an incoming reply, it
// returns the next status and the messages to send. No I/O, so every branch is
// unit-tested. Replies that do not fit the current status (duplicates, late
// arrivals) are ignored, which makes the saga safe under redelivery.
const { ROUTES, orderPlacedData } = require('./messages');

const STATUS = Object.freeze({
  PENDING: 'PENDING',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
});

// Step 1, run when the order is created: reserve stock, and announce the order.
function start(order) {
  return [
    {
      ...ROUTES.reserveStock,
      data: { orderId: order.id, items: order.items.map(({ sku, quantity }) => ({ sku, quantity })) },
    },
    { ...ROUTES.orderPlaced, data: orderPlacedData(order) },
  ];
}

function ignore(reason) {
  return { ignored: true, reason };
}

function next(order, replyType, reply) {
  switch (replyType) {
    case 'inventory.stock-reserved.v1':
      if (order.status !== STATUS.PENDING) return ignore(`stock-reserved while ${order.status}`);
      return {
        status: STATUS.AWAITING_PAYMENT,
        step: 'stock-reserved',
        messages: [
          {
            ...ROUTES.authorisePayment,
            data: {
              orderId: order.id,
              amountCents: order.totalCents,
              currency: order.currency,
              paymentToken: order.paymentToken,
            },
          },
        ],
      };

    case 'inventory.stock-rejected.v1':
      if (order.status !== STATUS.PENDING) return ignore(`stock-rejected while ${order.status}`);
      return {
        status: STATUS.REJECTED,
        reason: 'OUT_OF_STOCK',
        step: 'stock-rejected',
        messages: [{ ...ROUTES.orderRejected, data: rejected(order, 'OUT_OF_STOCK', reply) }],
      };

    case 'payment.authorised.v1':
      if (order.status !== STATUS.AWAITING_PAYMENT) return ignore(`payment-authorised while ${order.status}`);
      return {
        status: STATUS.CONFIRMED,
        step: 'payment-authorised',
        messages: [
          {
            ...ROUTES.orderConfirmed,
            data: { orderId: order.id, customerId: order.customerId, totalCents: order.totalCents, currency: order.currency },
          },
        ],
      };

    case 'payment.failed.v1':
      if (order.status !== STATUS.AWAITING_PAYMENT) return ignore(`payment-failed while ${order.status}`);
      // Compensation: stock was reserved in an earlier step, so give it back.
      return {
        status: STATUS.REJECTED,
        reason: 'PAYMENT_DECLINED',
        step: 'payment-failed',
        messages: [
          { ...ROUTES.releaseStock, data: { orderId: order.id } },
          { ...ROUTES.orderRejected, data: rejected(order, 'PAYMENT_DECLINED', reply) },
        ],
      };

    case 'inventory.stock-released.v1':
      // Confirmation that the compensating action completed; recorded, no state change.
      return { status: order.status, reason: order.reason, step: 'compensation-completed', messages: [] };

    default:
      return ignore(`unknown reply ${replyType}`);
  }
}

function rejected(order, reason, reply) {
  return { orderId: order.id, customerId: order.customerId, reason, detail: reply || {} };
}

module.exports = { STATUS, start, next };
