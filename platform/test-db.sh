#!/usr/bin/env bash
# Database rules, checked on a throwaway local Postgres: loads every schema file in order (with a small stand-in for
# Supabase's sign-in tables), then runs test-db.sql. Needs Postgres 16 binaries (present on GitHub's Ubuntu runners).
# Run: bash platform/test-db.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ "$(id -u)" = 0 ]; then  # Postgres won't run as root
  T="$(mktemp -d)"; cp "$HERE"/schema*.sql "$HERE"/test-db*.sql "$HERE"/test-db.sh "$T"/; chmod -R a+rX "$T"
  exec runuser -u postgres -- bash "$T/test-db.sh"
fi
BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"; [ -n "$BIN" ] && PATH="$BIN:$PATH"
D="$(mktemp -d)"; trap 'pg_ctl -D "$D/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$D"' EXIT
initdb -D "$D/data" -A trust -U postgres >/dev/null
pg_ctl -D "$D/data" -o "-c listen_addresses='' -k $D" -w start >/dev/null
export PGOPTIONS="-c client_min_messages=warning"
P=(psql -h "$D" -U postgres -v ON_ERROR_STOP=1 -q -X -o /dev/null)
"${P[@]}" -f "$HERE/test-db-stub.sql" >/dev/null
# schema-wake.sql is left out: it needs Supabase's pg_net and Vault, and only sends a wake-up call.
for f in schema.sql schema-actions.sql schema-findings.sql schema-pages-captures.sql schema-page-serving.sql schema-runner.sql schema-review-flow.sql schema-fonts.sql schema-guards.sql schema-guards.sql schema-review-links.sql schema-review-links.sql; do
  "${P[@]}" -f "$HERE/$f" >/dev/null
done
"${P[@]}" -f "$HERE/test-db.sql"
