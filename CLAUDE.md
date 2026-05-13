# Contexto del proyecto — lemut_n8n

Primer cliente del **Framework Bot**: motor modular en n8n para agentes
de mensajería para PyMEs mexicanas. Mismo motor, distintos clientes
vía configuración. Lemut = primer cliente.

## Estado

- **Fase 1 — completa.** Echo bot por Telegram con n8n + Postgres en
  Docker, tunnel público con cloudflared, repo en GitHub privado.
- **Fase 2 — completa.** Bot inteligente con **Gemini 2.5 Flash-Lite**:
  recibe mensaje en Telegram → Gemini responde → manda respuesta al
  mismo chat. Incluye manejo de errores y truncado para Telegram.
- **Fase 3 — pendiente.** Memoria de conversación (historial en Postgres
  para que el bot recuerde contexto entre mensajes).

## Stack actual
- **n8n** 1.80.0 — orquestador
- **Postgres** 16.6 — BD de n8n
- **Cloudflared** 2024.12.2 — tunnel público (quick tunnel, sin cuenta)
- **Gemini** `gemini-2.5-flash-lite` — LLM
- **Docker Compose** — despliegue local

## Reglas no negociables
- **Versiones fijas siempre.** Nada de `:latest`.
- **`.env` contiene secretos reales** — no modificarlo a menos que el
  usuario lo pida explícitamente. Si se agrega una variable nueva,
  actualizar `.env.example` (sin valores).
- **`.gitignore` debe excluir `.env` y `.tunnel.env`** — verificar
  antes de cualquier push.
- **Comentarios y documentación en español.**
- **Timezone:** `America/Mexico_City` en todos los contenedores.
- **Antes de comandos destructivos** (`rm`, `docker volume prune`,
  `git push --force`, `docker compose down -v`, drop SQL): preguntar.

## Variables en `.env`
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- `N8N_USER`, `N8N_PASSWORD` (referencia para el owner account, no se
  pasan al contenedor — el owner se crea por UI)
- `TELEGRAM_BOT_TOKEN`
- `GEMINI_API_KEY`

## Cómo levantar el stack
- **NO usar `docker compose up` directo.** Usar siempre `./scripts/up.sh`.
- El script:
  1. Levanta postgres + cloudflared
  2. Si la URL guardada en `.tunnel.env` aún responde, la reusa
  3. Si no responde (stale), reinicia cloudflared y espera URL nueva viva
  4. Escribe `.tunnel.env` con la URL buena
  5. Recrea n8n con la URL en su env
- Bajar con `./scripts/down.sh`. Para borrar datos: `docker compose down -v`.

## Cuando la URL del tunnel cambia
- Los quick tunnels de Cloudflare expiran tras horas y `up.sh` los
  detecta y refresca. Cuando refresca, la URL es distinta.
- Después de un refresh: **reactivar el workflow con trigger de webhook
  en la UI** (toggle off → on) para que n8n re-registre con Telegram.

## Workflow "Gemini Chat"
```
Telegram Trigger ──► Basic LLM Chain ──► Send Reply         (camino feliz)
                          │
                          └► (error) ──► Send Fallback      (Gemini falló)

Google Gemini Chat Model ──► Basic LLM Chain   (gemini-2.5-flash-lite)
```
- System prompt fijo: "Eres un asistente útil y conciso. Respondes en
  español mexicano. Máximo 3 oraciones."
- Respuesta truncada a 4090 chars (límite de Telegram es 4096).
- Si Gemini falla, el usuario recibe "Disculpa, hubo un problema..."
  en lugar de silencio.

## Credenciales en n8n (nombres exactos para matching automático)
- `Telegram account` (tipo `telegramApi`)
- `Gemini Lemut` (tipo `googlePalmApi` — sí, dice "PaLM" en n8n por
  motivos históricos, pero usa la API de Gemini moderna)

Si se importa el JSON con esos nombres, los nodos se conectan solos.

## Estilo de trabajo
- Usuario principiante en infra/devops, intermedio en programación.
- Explicar brevemente **antes** de actuar. Conciso, sin relleno.
- Si hay dos enfoques razonables: presentar ambos y recomendar uno.
- Detenerse en los checkpoints del plan; no avanzar sin OK explícito.

## Estructura del repo
```
lemut_n8n/
├── CLAUDE.md              ← este archivo
├── README.md              ← cómo levantar el proyecto
├── .env                   ← secretos reales (NO commitear)
├── .env.example           ← plantilla pública
├── .tunnel.env            ← generado por up.sh (NO commitear)
├── .gitignore
├── docker-compose.yml     ← postgres + n8n + cloudflared
├── scripts/
│   ├── up.sh              ← arranque con auto-refresh de tunnel
│   └── down.sh            ← apagado
└── workflows/
    ├── echo.json          ← echo bot (Fase 1, referencia)
    └── gemini_chat.json   ← bot con Gemini (Fase 2, activo)
```
