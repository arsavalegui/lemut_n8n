# lemut_n8n

Primer proyecto del **Framework Bot**: motor modular en n8n para
construir agentes de mensajería para PyMEs mexicanas.

## Estado actual

- **Fase 1 (completa):** echo bot de Telegram con n8n + Postgres en
  Docker, tunnel público con cloudflared, repo en GitHub.
- **Fase 2 (completa):** integración con **Google Gemini 2.5 Flash-Lite**.
  El bot recibe mensajes de cualquier usuario en Telegram, los manda a
  Gemini y responde. Incluye manejo de errores y truncado de respuestas
  largas para Telegram.
- **Fase 3 (pendiente):** memoria de conversación con Postgres.

## Stack

| Componente   | Versión        | Rol                                                  |
| ---          | ---            | ---                                                  |
| n8n          | 1.80.0         | Orquestador de workflows                             |
| Postgres     | 16.6           | Base de datos de n8n                                 |
| Cloudflared  | 2024.12.2      | Tunnel público (Telegram → tu localhost)             |
| Gemini       | 2.5 Flash-Lite | LLM que responde los mensajes                        |

Timezone fijo: `America/Mexico_City`.

## Requisitos

- Docker y Docker Compose v2
- Un bot de Telegram creado con [@BotFather](https://t.me/BotFather)
- Una API key de Google AI Studio: <https://aistudio.google.com/apikey>

## Cómo levantarlo

1. **Variables de entorno**

   ```bash
   cp .env.example .env
   # Editar .env con valores reales
   ```

   Variables requeridas:
   - `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
   - `N8N_USER`, `N8N_PASSWORD` (referencia para crear el owner account)
   - `TELEGRAM_BOT_TOKEN` (del bot de @BotFather)
   - `GEMINI_API_KEY` (de Google AI Studio)

2. **Arrancar el stack**

   ```bash
   ./scripts/up.sh
   ```

   El script:
   - Levanta postgres y cloudflared
   - Verifica si la URL del tunnel guardada aún funciona; si no, reinicia
     cloudflared y espera URL nueva viva
   - Escribe `.tunnel.env` con la URL actual
   - Levanta n8n con esa URL como `WEBHOOK_URL`

   Al terminar imprime algo como:

   ```
   ✓ Stack listo.
     • n8n UI (local):    http://localhost:5678
     • n8n público:       https://random-words.trycloudflare.com
   ```

3. **Acceder a n8n**

   <http://localhost:5678> — primer arranque pide crear el owner account.

4. **Importar el workflow Gemini**

   Si es la primera vez: *Workflows → Import from File* → `workflows/gemini_chat.json`
   (también disponible en `~/Downloads/lemut-gemini-chat.json` si lo
   prefieres). Crea primero la credencial `Telegram account`
   (tipo Telegram API) y `Gemini Lemut` (tipo Google Gemini API)
   para que el matching automático conecte los nodos.

5. **Detener el stack**

   ```bash
   ./scripts/down.sh
   ```

   Los volúmenes (postgres_data, n8n_data) se conservan.

## Sobre el tunnel

Cloudflared en modo *quick tunnel* da una URL pública aleatoria en
`*.trycloudflare.com` sin cuenta ni autenticación. Limitaciones:

- La URL puede expirar tras varias horas. `./scripts/up.sh` detecta esto
  con un `curl` y reinicia cloudflared automáticamente para obtener
  una nueva.
- Cuando la URL cambia, hay que **reactivar los workflows con trigger de
  webhook** (toggle off → on en la UI) para que n8n re-registre la
  nueva URL con Telegram.
- Es para desarrollo local. Para producción: dominio propio con
  Cloudflare Tunnel autenticado o un VPS.

## Workflow Gemini Chat

```
Telegram Trigger ──► Basic LLM Chain ──► Send Reply         (camino feliz)
                          │
                          └► (error) ──► Send Fallback      (Gemini falló)

Google Gemini Chat Model ──► Basic LLM Chain   (gemini-2.5-flash-lite)
```

- **System prompt:** "Eres un asistente útil y conciso. Respondes en
  español mexicano. Máximo 3 oraciones."
- **Truncado:** la respuesta se corta a 4090 chars para no rebasar el
  límite de Telegram (4096).
- **Manejo de error:** si Gemini falla (rate limit, API down, etc.) el
  usuario recibe "Disculpa, hubo un problema, intenta de nuevo en un
  momento" en lugar de silencio.

## Estructura

```
lemut_n8n/
├── CLAUDE.md            Contexto para asistentes de IA
├── README.md
├── .env.example         Plantilla de variables (sin valores)
├── .gitignore           Excluye .env y .tunnel.env
├── docker-compose.yml   Servicios postgres, n8n, cloudflared
├── scripts/
│   ├── up.sh            Arranque con auto-refresh de tunnel
│   └── down.sh          Apagado
└── workflows/
    ├── echo.json        Echo bot (Fase 1, referencia)
    └── gemini_chat.json Bot con Gemini (Fase 2, activo)
```

## Notas

- El puerto de Postgres **no** se expone al host. Solo n8n lo ve.
- Postgres persiste en el volumen `postgres_data`.
- `.env` y `.tunnel.env` nunca deben entrar al repositorio.
- El workflow `echo.json` se conserva como referencia; en producción
  solo uno de los dos workflows puede estar activo a la vez (comparten
  el bot de Telegram).
