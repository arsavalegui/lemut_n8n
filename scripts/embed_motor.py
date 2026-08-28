#!/usr/bin/env python3
"""Genera workflows/agenda_cliente.json embebiendo workflows/src/motor_agenda.js.

El motor de la agenda se edita en su archivo .js (legible y testeable);
este script lo mete como jsCode del nodo Code y escribe el workflow
completo. Correr desde la raíz del repo:  python3 scripts/embed_motor.py
"""
import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
MOTOR = (RAIZ / "workflows/src/motor_agenda.js").read_text()

TELEGRAM_CRED = {"id": "Fw58BUoSTogqEGTc", "name": "Telegram account"}
POSTGRES_CRED = {"id": "PostgresLemut001", "name": "Postgres Lemut"}

workflow = {
    "id": "LemutAgendaCli01",
    "name": "Agenda Cliente",
    "active": False,
    "nodes": [
        {
            "id": "node-entrada",
            "name": "Entrada",
            "type": "n8n-nodes-base.executeWorkflowTrigger",
            "typeVersion": 1.1,
            "position": [200, 300],
            "parameters": {"inputSource": "passthrough"},
        },
        {
            "id": "node-leer-estado",
            "name": "Leer estado",
            "type": "n8n-nodes-base.postgres",
            "typeVersion": 2.5,
            "position": [400, 300],
            "alwaysOutputData": True,
            "parameters": {
                "operation": "executeQuery",
                "query": "SELECT state, context_json FROM agenda.conversation_state WHERE chat_id = $1::bigint;",
                "options": {
                    "queryReplacement": "={{ $json.callback_query?.message?.chat?.id ?? $json.message?.chat?.id ?? 0 }}"
                },
            },
            "credentials": {"postgres": POSTGRES_CRED},
        },
        {
            "id": "node-leer-mis-citas",
            "name": "Leer mis citas",
            "type": "n8n-nodes-base.postgres",
            "typeVersion": 2.5,
            "position": [500, 140],
            "alwaysOutputData": True,
            "parameters": {
                "operation": "executeQuery",
                # Citas futuras confirmadas del chat, para /miscitas.
                "query": "SELECT id, trabajador, servicio, to_char(fecha, 'YYYY-MM-DD') AS fecha_iso, to_char(hora_inicio, 'HH24:MI') AS ini FROM agenda.bookings WHERE cliente_chat_id = $1::bigint AND estado = 'confirmada' AND (fecha > (now() AT TIME ZONE 'America/Mexico_City')::date OR (fecha = (now() AT TIME ZONE 'America/Mexico_City')::date AND hora_inicio > (now() AT TIME ZONE 'America/Mexico_City')::time)) ORDER BY fecha, hora_inicio LIMIT 10;",
                "options": {
                    "queryReplacement": "={{ $('Entrada').first().json.callback_query?.message?.chat?.id ?? $('Entrada').first().json.message?.chat?.id ?? 0 }}"
                },
            },
            "credentials": {"postgres": POSTGRES_CRED},
        },
        {
            "id": "node-leer-citas",
            "name": "Leer citas",
            "type": "n8n-nodes-base.postgres",
            "typeVersion": 2.5,
            "position": [600, 300],
            "alwaysOutputData": True,
            "parameters": {
                "operation": "executeQuery",
                # Solo aporta datos reales en el paso dia|; en los demás pasos
                # los parámetros dummy regresan cero filas y no estorban.
                # Ojo: n8n descarta parámetros que evalúan a cadena vacía
                # (truena con "there is no parameter $N"), por eso el
                # barbero ausente viaja como '-' y no como ''.
                "query": "SELECT to_char(hora_inicio, 'HH24:MI') AS ini, to_char(hora_fin, 'HH24:MI') AS fin FROM agenda.bookings WHERE estado = 'confirmada' AND trabajador = $1 AND fecha = $2::date;",
                "options": {
                    "queryReplacement": "={{ $('Leer estado').first()?.json?.context_json?.barbero || '-' }},{{ ($('Entrada').first().json.callback_query?.data ?? '').startsWith('dia|') ? $('Entrada').first().json.callback_query.data.slice(4) : '1970-01-01' }}"
                },
            },
            "credentials": {"postgres": POSTGRES_CRED},
        },
        {
            "id": "node-leer-doc",
            "name": "Leer doc del negocio",
            "type": "n8n-nodes-base.readWriteFile",
            "typeVersion": 1,
            "position": [800, 300],
            "parameters": {
                "operation": "read",
                "fileSelector": "/knowledge/barberia_ejemplo.md",
                "options": {},
            },
        },
        {
            "id": "node-extraer-texto",
            "name": "Extraer texto",
            "type": "n8n-nodes-base.extractFromFile",
            "typeVersion": 1,
            "position": [1000, 300],
            "parameters": {"operation": "text", "options": {}},
        },
        {
            "id": "node-motor",
            "name": "Motor de agenda",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1200, 300],
            "parameters": {"jsCode": MOTOR},
        },
        {
            "id": "node-insertar-cita",
            "name": "Insertar cita",
            "type": "n8n-nodes-base.postgres",
            "typeVersion": 2.5,
            "position": [1400, 180],
            "alwaysOutputData": True,
            "parameters": {
                "operation": "executeQuery",
                # INSERT atómico: sólo entra si $1='book' Y ningún booking
                # confirmado del mismo barbero se traslapa (NOT EXISTS).
                # El índice único parcial cubre el empate exacto de carrera.
                "query": "INSERT INTO agenda.bookings (trabajador, servicio, duracion_min, fecha, hora_inicio, hora_fin, cliente_nombre, cliente_telefono, cliente_chat_id, estado) SELECT $2, $3, $4::int, $5::date, $6::time, $7::time, convert_from(decode($8, 'base64'), 'UTF8'), $9, $10::bigint, 'confirmada' WHERE $1 = 'book' AND NOT EXISTS (SELECT 1 FROM agenda.bookings WHERE estado = 'confirmada' AND trabajador = $2 AND fecha = $5::date AND hora_inicio < $7::time AND hora_fin > $6::time) ON CONFLICT (trabajador, fecha, hora_inicio) WHERE estado = 'confirmada' DO NOTHING RETURNING id;",
                "options": {
                    "queryReplacement": "={{ $json.booking.action }},{{ $json.booking.trabajador }},{{ $json.booking.servicio }},{{ $json.booking.dur }},{{ $json.booking.fecha }},{{ $json.booking.ini }},{{ $json.booking.fin }},{{ $json.booking.nombreB64 }},{{ $json.booking.telefono }},{{ $json.booking.cliente_chat_id }}"
                },
            },
            "credentials": {"postgres": POSTGRES_CRED},
        },
        {
            "id": "node-cancelar-cita",
            "name": "Cancelar cita",
            "type": "n8n-nodes-base.postgres",
            "typeVersion": 2.5,
            "position": [1400, 60],
            "alwaysOutputData": True,
            "parameters": {
                "operation": "executeQuery",
                # UPDATE gateado: solo cancela citas del propio chat, futuras
                # y confirmadas (un cxl|id ajeno o viejo no hace nada).
                "query": "UPDATE agenda.bookings SET estado = 'cancelada' WHERE $1 = 'cancel' AND id = $2::int AND cliente_chat_id = $3::bigint AND estado = 'confirmada' AND (fecha > (now() AT TIME ZONE 'America/Mexico_City')::date OR (fecha = (now() AT TIME ZONE 'America/Mexico_City')::date AND hora_inicio > (now() AT TIME ZONE 'America/Mexico_City')::time)) RETURNING id, trabajador, servicio, to_char(fecha, 'DD/MM') AS fecha_fmt, to_char(hora_inicio, 'HH24:MI') AS ini, cliente_nombre, cliente_telefono;",
                "options": {
                    "queryReplacement": "={{ $('Motor de agenda').first().json.cancel_op.action }},{{ $('Motor de agenda').first().json.cancel_op.id }},{{ $('Motor de agenda').first().json.chat_id }}"
                },
            },
            "credentials": {"postgres": POSTGRES_CRED},
        },
        {
            "id": "node-leer-admins",
            "name": "Leer admins",
            "type": "n8n-nodes-base.postgres",
            "typeVersion": 2.5,
            "position": [1400, 420],
            "alwaysOutputData": True,
            "parameters": {
                "operation": "executeQuery",
                "query": "SELECT chat_id FROM agenda.admins;",
                "options": {},
            },
            "credentials": {"postgres": POSTGRES_CRED},
        },
        {
            "id": "node-resolver",
            "name": "Resolver reserva",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1560, 300],
            "parameters": {
                "jsCode": (
                    "// Si el motor pidió reservar o cancelar, arma los mensajes según el\n"
                    "// resultado del INSERT/UPDATE: confirmación al cliente + aviso a cada\n"
                    "// admin. Si no hubo operación de BD, passthrough.\n"
                    "const m = $('Motor de agenda').first().json;\n"
                    "if (m.cancel_op?.action === 'cancel') {\n"
                    "  const canceladas = $('Cancelar cita').all().map(i => i.json).filter(r => r.id !== undefined);\n"
                    "  const admins = $('Leer admins').all().map(i => i.json).filter(a => a.chat_id);\n"
                    "  const payloads = [...m.payloads];\n"
                    "  if (canceladas.length > 0) {\n"
                    "    const c = canceladas[0];\n"
                    "    payloads.push({ method: 'sendMessage', body: {\n"
                    "      chat_id: m.chat_id,\n"
                    "      text: `Listo: cancelé tu cita del ${c.fecha_fmt} a las ${c.ini} (${c.servicio} con ${c.trabajador}). Si quieres apartar otra, escribe \"agendar\".`,\n"
                    "    } });\n"
                    "    for (const a of admins) {\n"
                    "      payloads.push({ method: 'sendMessage', body: {\n"
                    "        chat_id: a.chat_id,\n"
                    "        text: `Cita cancelada por el cliente\\n\\n${c.fecha_fmt} · ${c.ini}\\nServicio: ${c.servicio}\\nBarbero: ${c.trabajador}\\nCliente: ${c.cliente_nombre} · ${c.cliente_telefono}`,\n"
                    "      } });\n"
                    "    }\n"
                    "  } else {\n"
                    "    payloads.push({ method: 'sendMessage', body: {\n"
                    "      chat_id: m.chat_id,\n"
                    "      text: 'Esa cita ya no se pudo cancelar (quizá ya pasó o ya estaba cancelada). Escribe mis citas para ver tus citas vigentes.',\n"
                    "    } });\n"
                    "  }\n"
                    "  return [{ json: { chat_id: m.chat_id, payloads, state_op: m.state_op } }];\n"
                    "}\n"
                    "if (m.booking.action !== 'book') {\n"
                    "  return [{ json: { chat_id: m.chat_id, payloads: m.payloads, state_op: m.state_op } }];\n"
                    "}\n"
                    "const insertadas = $('Insertar cita').all().map(i => i.json).filter(r => r.id !== undefined);\n"
                    "const admins = $('Leer admins').all().map(i => i.json).filter(a => a.chat_id);\n"
                    "const b = m.booking;\n"
                    "const nombre = Buffer.from(b.nombreB64, 'base64').toString('utf8');\n"
                    "const payloads = [...m.payloads];\n"
                    "const state_op = { action: 'clear', state: '-', ctxB64: 'e30=' };\n"
                    "if (insertadas.length > 0) {\n"
                    "  payloads.push({ method: 'sendMessage', body: {\n"
                    "    chat_id: m.chat_id,\n"
                    "    text: `¡Cita confirmada, ${nombre}!\\n\\nServicio: ${b.servicio}\\nBarbero: ${b.trabajador}\\nFecha: ${b.fechaEtiqueta} de ${b.ini} a ${b.fin}\\n\\nSi no puedes venir, avísanos con anticipación. ¡Te esperamos!`,\n"
                    "    reply_markup: { remove_keyboard: true },\n"
                    "  } });\n"
                    "  for (const a of admins) {\n"
                    "    payloads.push({ method: 'sendMessage', body: {\n"
                    "      chat_id: a.chat_id,\n"
                    "      text: `Nueva cita agendada\\n\\n${b.fechaEtiqueta} · ${b.ini}–${b.fin}\\nServicio: ${b.servicio}\\nBarbero: ${b.trabajador}\\nCliente: ${nombre} · ${b.telefono}`,\n"
                    "    } });\n"
                    "  }\n"
                    "} else {\n"
                    "  payloads.push({ method: 'sendMessage', body: {\n"
                    "    chat_id: m.chat_id,\n"
                    "    text: 'Uy, ese horario se acaba de ocupar. Escribe \"agendar\" para elegir otro.',\n"
                    "    reply_markup: { remove_keyboard: true },\n"
                    "  } });\n"
                    "}\n"
                    "return [{ json: { chat_id: m.chat_id, payloads, state_op } }];"
                ),
            },
        },
        {
            "id": "node-guardar-estado",
            "name": "Guardar estado",
            "type": "n8n-nodes-base.postgres",
            "typeVersion": 2.5,
            "position": [1400, 300],
            "alwaysOutputData": True,
            "parameters": {
                "operation": "executeQuery",
                # Una sola query que setea, borra o no hace nada según $2.
                # El contexto viaja en base64 porque queryReplacement separa
                # parámetros por comas y un JSON las trae.
                "query": "WITH del AS (DELETE FROM agenda.conversation_state WHERE chat_id = $1::bigint AND $2 = 'clear') INSERT INTO agenda.conversation_state (chat_id, state, context_json) SELECT $1::bigint, $3, convert_from(decode($4, 'base64'), 'UTF8')::jsonb WHERE $2 = 'set' ON CONFLICT (chat_id) DO UPDATE SET state = EXCLUDED.state, context_json = EXCLUDED.context_json, updated_at = now();",
                "options": {
                    "queryReplacement": "={{ $json.chat_id }},{{ $json.state_op.action }},{{ $json.state_op.state }},{{ $json.state_op.ctxB64 }}"
                },
            },
            "credentials": {"postgres": POSTGRES_CRED},
        },
        {
            "id": "node-preparar",
            "name": "Preparar llamadas",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1600, 300],
            "parameters": {
                "jsCode": "// Un item por llamada a la API de Telegram que dejó lista el resolver.\nreturn $('Resolver reserva').first().json.payloads.map(p => ({ json: p }));"
            },
        },
        {
            "id": "node-llamar-telegram",
            "name": "Llamar Telegram",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1800, 300],
            "onError": "continueRegularOutput",
            "parameters": {
                "method": "POST",
                "url": "={{ 'https://api.telegram.org/bot' + $env.TELEGRAM_BOT_TOKEN + '/' + $json.method }}",
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={{ JSON.stringify($json.body) }}",
                "options": {},
            },
        },
    ],
    "connections": {
        "Entrada": {"main": [[{"node": "Leer estado", "type": "main", "index": 0}]]},
        "Leer estado": {"main": [[{"node": "Leer mis citas", "type": "main", "index": 0}]]},
        "Leer mis citas": {"main": [[{"node": "Leer citas", "type": "main", "index": 0}]]},
        "Leer citas": {"main": [[{"node": "Leer doc del negocio", "type": "main", "index": 0}]]},
        "Leer doc del negocio": {"main": [[{"node": "Extraer texto", "type": "main", "index": 0}]]},
        "Extraer texto": {"main": [[{"node": "Motor de agenda", "type": "main", "index": 0}]]},
        "Motor de agenda": {"main": [[{"node": "Insertar cita", "type": "main", "index": 0}]]},
        "Insertar cita": {"main": [[{"node": "Cancelar cita", "type": "main", "index": 0}]]},
        "Cancelar cita": {"main": [[{"node": "Leer admins", "type": "main", "index": 0}]]},
        "Leer admins": {"main": [[{"node": "Resolver reserva", "type": "main", "index": 0}]]},
        "Resolver reserva": {"main": [[{"node": "Guardar estado", "type": "main", "index": 0}]]},
        "Guardar estado": {"main": [[{"node": "Preparar llamadas", "type": "main", "index": 0}]]},
        "Preparar llamadas": {"main": [[{"node": "Llamar Telegram", "type": "main", "index": 0}]]},
    },
    "settings": {"executionOrder": "v1", "timezone": "America/Mexico_City"},
}

destino = RAIZ / "workflows/agenda_cliente.json"
destino.write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + "\n")
print(f"OK → {destino}")
