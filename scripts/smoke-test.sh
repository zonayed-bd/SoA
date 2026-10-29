#!/usr/bin/env bash
# End-to-end smoke test against a running `docker compose` stack.
# Used by the CI integration stage and runnable on a laptop:
#   ORDER_HOST_PORT=8080 ./scripts/smoke-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-http://localhost:${ORDER_HOST_PORT:-8080}}"
failures=0

pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; failures=$((failures + 1)); }
uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }

place_order() { # <idempotency-key> <correlation-id> <json-body>
  curl -sS -X POST "$BASE_URL/v1/orders" \
    -H 'content-type: application/json' -H "idempotency-key: $1" -H "x-correlation-id: $2" -d "$3"
}

wait_for_status() { # <order-id> <expected-status>
  local status=""
  for _ in $(seq 1 40); do
    status=$(curl -sS "$BASE_URL/v1/orders/$1" | jq -r .status)
    [[ "$status" == "$2" ]] && return 0
    sleep 0.5
  done
  echo "    last status was $status"
  return 1
}

stock_of() { docker compose exec -T inventory-service wget -qO- "http://127.0.0.1:3000/v1/stock/$1" | jq -r .available; }

echo "1. Happy path: order is confirmed through the saga"
corr=$(uuid)
body='{"customerId":"cust-1001","paymentToken":"tok_visa_approved","items":[{"sku":"SKU-KETTLE-17","quantity":2},{"sku":"SKU-AIRFRYER-5L","quantity":1}]}'
key="smoke-$(uuid)"
order_id=$(place_order "$key" "$corr" "$body" | jq -r .orderId)
if wait_for_status "$order_id" CONFIRMED; then pass "order $order_id CONFIRMED"; else fail "order $order_id not confirmed"; fi

echo "2. Idempotency: retrying with the same key returns the same order"
replay_id=$(place_order "$key" "$corr" "$body" | jq -r .orderId)
if [[ "$replay_id" == "$order_id" ]]; then pass "replay returned $replay_id"; else fail "replay created $replay_id"; fi

echo "3. Declined payment: saga compensates and releases the stock"
before=$(stock_of SKU-TV55-OLED)
declined_id=$(place_order "smoke-$(uuid)" "$(uuid)" \
  '{"customerId":"cust-1002","paymentToken":"tok_declined_insufficient_funds","items":[{"sku":"SKU-TV55-OLED","quantity":1}]}' | jq -r .orderId)
if wait_for_status "$declined_id" REJECTED; then pass "order $declined_id REJECTED"; else fail "declined order not rejected"; fi
for _ in $(seq 1 20); do
  steps=$(curl -sS "$BASE_URL/v1/orders/$declined_id" | jq -r '[.saga[].step] | join(",")')
  [[ "$steps" == *compensation-completed* ]] && break
  sleep 0.5
done
after=$(stock_of SKU-TV55-OLED)
if [[ "$steps" == *compensation-completed* && "$after" == "$before" ]]; then
  pass "compensation completed, stock back to $after"
else
  fail "compensation incomplete (steps=$steps, stock $before -> $after)"
fi

echo "4. Out of stock: order is rejected without taking payment"
oos_id=$(place_order "smoke-$(uuid)" "$(uuid)" \
  '{"customerId":"cust-1001","paymentToken":"tok_visa_approved","items":[{"sku":"SKU-LAPTOP-14","quantity":1}]}' | jq -r .orderId)
if wait_for_status "$oos_id" REJECTED; then pass "order $oos_id REJECTED (OUT_OF_STOCK)"; else fail "out-of-stock order not rejected"; fi

echo "5. Event consumed by the Notification service with the same correlation id"
found=0
for _ in $(seq 1 20); do
  if docker compose logs --no-color --no-log-prefix notification-service | grep -q "\"correlation_id\":\"$corr\".*notification.sent\|notification.sent.*\"correlation_id\":\"$corr\""; then
    found=1
    break
  fi
  sleep 0.5
done
if [[ $found == 1 ]]; then pass "notification-service logged correlation_id $corr"; else fail "no notification for $corr"; fi

echo
if [[ $failures -eq 0 ]]; then echo "All smoke tests passed"; else echo "$failures smoke test(s) failed"; exit 1; fi
