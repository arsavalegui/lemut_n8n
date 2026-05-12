# Contexto del proyecto — lemut_n8n

Primer proyecto del **Framework Bot**: un motor modular en n8n para
construir agentes de mensajería para PyMEs mexicanas. Mismo motor,
distintos clientes vía configuración. Este repo es el cliente "Lemut".

## Stack (Fase 1)
- **n8n** 1.80.0 — orquestador de workflows
- **Postgres** 16.6 — base de datos
- **Cloudflared** 2024.12.2 — tunnel público (quick tunnel sin cuenta)
  para que Telegram pueda alcanzar el webhook de n8n.
- **Telegram** — canal de prueba (NO usamos WhatsApp todavía)
- **Docker Compose** — despliegue local
- Sin LLM en esta fase. Primer hito: echo bot por Telegram.

## Cómo levantar el stack
- **NO uses `docker compose up` directo.** El orden importa porque la
  URL del tunnel debe escribirse en `.tunnel.env` antes de que n8n
  arranque, para que `WEBHOOK_URL` y `N8N_HOST` apunten al tunnel.
- Usar `./scripts/up.sh` (levanta postgres + cloudflared, espera URL,
  escribe `.tunnel.env`, levanta n8n).
- Bajar con `./scripts/down.sh`. Para borrar datos: `docker compose down -v`.

## Limitación conocida del tunnel
- Quick tunnel de Cloudflare da URL aleatoria que **cambia al reiniciar
  cloudflared**. Hay que reactivar workflows con trigger de webhook
  cada vez para que re-registren la nueva URL con Telegram.
- Para producción: dominio propio + Cloudflare Tunnel autenticado o VPS.

## Reglas no negociables
- **Versiones fijas siempre.** Nada de `:latest` en imágenes.
- **Nunca tocar `.env`.** Contiene secretos reales. Solo se mantiene
  `.env.example` con las llaves vacías.
- **`.gitignore` debe excluir `.env`** — verificar antes de cualquier push.
- **Comentarios y documentación en español.**
- **Timezone:** `America/Mexico_City` en todos los contenedores.
- **Antes de comandos destructivos** (`rm`, `docker volume prune`,
  `git push --force`, `docker compose down -v`): preguntar primero.

## Variables esperadas en `.env`
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- `N8N_USER`, `N8N_PASSWORD`
- `TELEGRAM_BOT_TOKEN`

## Estilo de trabajo
- Usuario principiante en infra/devops, intermedio en programación.
- Explicar brevemente **antes** de actuar. Conciso, sin relleno.
- Si hay dos enfoques razonables: presentar ambos y recomendar uno.
- Detenerse en los checkpoints del plan; no avanzar sin OK explícito.

## Estructura del repo
```
lemut_n8n/
├── CLAUDE.md            ← este archivo
├── README.md            ← cómo levantar el proyecto
├── .env                 ← secretos reales (NO commitear)
├── .env.example         ← plantilla pública
├── .tunnel.env          ← generado por up.sh (NO commitear)
├── .gitignore
├── docker-compose.yml   ← postgres + n8n + cloudflared
├── scripts/
│   ├── up.sh            ← arranque con captura de URL de tunnel
│   └── down.sh          ← apagado
└── workflows/
    └── echo.json        ← echo bot de Telegram
```
