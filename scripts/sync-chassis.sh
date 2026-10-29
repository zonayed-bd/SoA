#!/usr/bin/env bash
# Copies the shared "microservice chassis" modules into every service.
# Each service gets its own copy so it can be built and released on its own;
# in production these would be published as a versioned internal npm package.
# Run with --check in CI to fail the build if a copy has drifted.
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-sync}"
status=0
for service in services/*/; do
  for file in chassis/*.js; do
    target="${service}src/lib/$(basename "$file")"
    if [[ "$mode" == "--check" ]]; then
      if ! cmp -s "$file" "$target"; then
        echo "drift: $target differs from $file"
        status=1
      fi
    else
      mkdir -p "${service}src/lib"
      cp "$file" "$target"
    fi
  done
done
exit $status
