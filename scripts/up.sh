#!/usr/bin/env bash
# Arranca el stack y garantiza que la URL del tunnel esté viva:
#
#   1. Levanta postgres + cloudflared
#   2. Si la URL guardada en .tunnel.env aún responde, la reusa.
#      Si no responde, reinicia cloudflared y espera URL nueva viva.
#   3. Escribe .tunnel.env con la URL buena
#   4. Recrea n8n con la URL actualizada en su env
#
# Uso: ./scripts/up.sh

set -euo pipefail
cd "$(dirname "$0")/.."

touch .tunnel.env

# --- helpers ---
url_alive() {
  # Considera la URL "viva" si curl recibe cualquier respuesta < 400 antes de 5s.
  local url="$1"
  [ -z "$url" ] && return 1
  curl -sf --max-time 5 -o /dev/null "$url"
}

extract_tunnel_url() {
  docker compose logs cloudflared 2>&1 \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' \
    | tail -1
}

# --- pasos ---
echo "▶ Levantando postgres y cloudflared..."
docker compose up -d postgres cloudflared >/dev/null

EXISTING_URL=$(grep '^WEBHOOK_URL=' .tunnel.env 2>/dev/null | cut -d= -f2- | sed 's:/$::' || true)

if [ -n "$EXISTING_URL" ] && url_alive "$EXISTING_URL"; then
  echo "▶ URL existente sigue viva, la reuso: $EXISTING_URL"
  URL="$EXISTING_URL/"
else
  if [ -n "$EXISTING_URL" ]; then
    echo "▶ URL existente no responde (stale), reiniciando cloudflared..."
    docker compose restart cloudflared >/dev/null
  fi

  echo "▶ Esperando URL del tunnel viva (timeout 60s)..."
  URL=""
  for i in $(seq 1 60); do
    CANDIDATE=$(extract_tunnel_url || true)
    # Si la última URL del log es la stale, esperar a que aparezca una nueva.
    if [ -n "$CANDIDATE" ] && [ "$CANDIDATE" != "$EXISTING_URL" ] && url_alive "$CANDIDATE"; then
      URL="$CANDIDATE/"
      break
    fi
    sleep 1
  done

  if [ -z "$URL" ]; then
    echo "✗ No se obtuvo URL del tunnel viva en 60s. Últimos logs:"
    docker compose logs cloudflared --tail 30
    exit 1
  fi
fi

HOST="${URL#https://}"
HOST="${HOST%/}"

cat > .tunnel.env <<EOF
# Generado automáticamente por scripts/up.sh — NO editar a mano.
WEBHOOK_URL=$URL
N8N_HOST=$HOST
N8N_PROTOCOL=https
EOF

echo "▶ Tunnel listo: $URL"
echo "▶ Recreando n8n con la URL actualizada..."
docker compose up -d --force-recreate n8n >/dev/null

echo ""
echo "✓ Stack listo."
echo "  • n8n UI (local):    http://localhost:5678"
echo "  • n8n público:       $URL"
echo ""
echo "  Notas:"
echo "  - Si la URL cambió respecto a la sesión anterior, reactiva los"
echo "    workflows con trigger de webhook (toggle off → on) para que"
echo "    n8n re-registre con Telegram."
echo "  - Vuelve a correr este script cuando algo deje de funcionar:"
echo "    detecta URL stale y la refresca solito."
