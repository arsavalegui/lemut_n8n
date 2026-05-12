#!/usr/bin/env bash
# Detiene el stack sin borrar volúmenes ni datos.
# Para borrar también datos (postgres, n8n) usar: docker compose down -v

set -euo pipefail
cd "$(dirname "$0")/.."

docker compose down
echo "✓ Stack detenido. Los volúmenes (postgres_data, n8n_data) se conservan."
