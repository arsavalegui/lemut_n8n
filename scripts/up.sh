#!/usr/bin/env bash
# Arranca el stack en el orden correcto:
#   1. postgres + cloudflared
#   2. Espera a que cloudflared publique su URL pública
#   3. Escribe la URL en .tunnel.env (consumida por n8n)
#   4. Levanta n8n con la URL ya conocida
#
# Uso: ./scripts/up.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# Garantiza que .tunnel.env exista (compose lo necesita aunque esté vacío).
touch .tunnel.env

echo "▶ Levantando postgres y cloudflared..."
docker compose up -d postgres cloudflared

echo "▶ Esperando URL del tunnel (timeout 60s)..."
URL=""
for i in $(seq 1 60); do
  URL=$(docker compose logs cloudflared 2>&1 \
        | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' \
        | tail -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "✗ No se obtuvo URL del tunnel en 60s. Logs:"
  docker compose logs cloudflared | tail -30
  exit 1
fi

HOST="${URL#https://}"
cat > .tunnel.env <<EOF
# Generado automáticamente por scripts/up.sh — NO editar a mano.
WEBHOOK_URL=$URL/
N8N_HOST=$HOST
N8N_PROTOCOL=https
EOF

echo "▶ URL del tunnel: $URL"
echo "▶ Escrita en .tunnel.env, levantando n8n..."

# Recrear n8n para que tome el nuevo env_file aunque ya estuviera corriendo.
docker compose up -d --force-recreate n8n

echo ""
echo "✓ Stack listo."
echo "  • n8n UI (local):    http://localhost:5678"
echo "  • n8n público:       $URL"
echo ""
echo "  Recuerda: si reinicias cloudflared, la URL cambia y debes"
echo "  volver a activar los workflows con trigger de webhook."
