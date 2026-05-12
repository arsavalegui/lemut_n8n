# lemut_n8n

Primer proyecto del **Framework Bot**: motor modular en n8n para
construir agentes de mensajería para PyMEs mexicanas.

Fase 1: echo bot en Telegram corriendo localmente con Docker.

## Stack

| Componente   | Versión        | Rol                                                  |
| ---          | ---            | ---                                                  |
| n8n          | 1.80.0         | Orquestador de workflows                             |
| Postgres     | 16.6           | Base de datos de n8n                                 |
| Cloudflared  | 2024.12.2      | Tunnel público (Telegram → tu localhost)             |

Timezone fijo: `America/Mexico_City`.

## Requisitos

- Docker y Docker Compose v2
- Un bot de Telegram creado con [@BotFather](https://t.me/BotFather)

## Cómo levantarlo

1. **Variables de entorno**

   ```bash
   cp .env.example .env
   # Editar .env con valores reales
   ```

   Variables requeridas:
   - `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
   - `N8N_USER`, `N8N_PASSWORD` (credenciales del owner account de n8n)
   - `TELEGRAM_BOT_TOKEN` (del bot de @BotFather)

2. **Arrancar el stack**

   ```bash
   ./scripts/up.sh
   ```

   El script levanta postgres + cloudflared, espera la URL pública del
   tunnel, la guarda en `.tunnel.env`, y luego levanta n8n con esa URL
   como `WEBHOOK_URL`.

   Al terminar imprime algo como:

   ```
   ✓ Stack listo.
     • n8n UI (local):    http://localhost:5678
     • n8n público:       https://random-words.trycloudflare.com
   ```

3. **Acceder a n8n**

   <http://localhost:5678> — primer arranque pide crear el owner account.

4. **Importar el workflow echo**

   Desde la UI: *Workflows → Import from File* → `workflows/echo.json`.
   Asignar la credencial de Telegram a ambos nodos.

5. **Detener el stack**

   ```bash
   ./scripts/down.sh
   ```

   Los volúmenes (postgres_data, n8n_data) se conservan.

## Sobre el tunnel

Cloudflared en modo *quick tunnel* da una URL pública aleatoria
en `*.trycloudflare.com` **sin cuenta ni autenticación**. Limitaciones:

- La URL **cambia cada vez que se reinicia cloudflared**. Si reinicias,
  hay que reactivar los workflows con trigger de webhook para que se
  re-registren con la nueva URL.
- Es para desarrollo local. Para producción, usa un dominio propio con
  Cloudflare Tunnel autenticado o un VPS.

## Estructura

```
lemut_n8n/
├── CLAUDE.md            Contexto para asistentes de IA
├── README.md
├── .env.example         Plantilla de variables (sin valores)
├── .gitignore           Excluye .env y .tunnel.env
├── docker-compose.yml   Servicios postgres, n8n, cloudflared
├── scripts/
│   ├── up.sh            Arranque con tunnel
│   └── down.sh          Apagado
└── workflows/
    └── echo.json        Echo bot de Telegram
```

## Notas

- El puerto de Postgres **no** se expone al host. Solo n8n lo ve.
- Postgres persiste en el volumen `postgres_data`.
- `.env` y `.tunnel.env` nunca deben entrar al repositorio.
