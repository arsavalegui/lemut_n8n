#!/usr/bin/env python3
"""Simulador E2E: inyecta updates de Telegram al webhook del bot y reporta
las respuestas REALES que el bot mandó (leídas de las ejecuciones de n8n).

Manda el update firmado con el secret del trigger (workflowId_nodeId), espera
a que terminen las ejecuciones que disparó, y extrae de execution_data todas
las respuestas de la API de Telegram (ok=true) — es decir, lo que de verdad
se envió al chat. Como usa un chat_id real, los mensajes también llegan al
Telegram de ese chat.

Uso:  python3 scripts/sim_telegram.py '<texto>'            (mensaje de texto)
      python3 scripts/sim_telegram.py --cb '<data>'        (tap de botón)
      python3 scripts/sim_telegram.py --contact '<tel>'    (compartir contacto)
Requiere CHAT_ID en el entorno o el default de abajo.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

WEBHOOK = "http://localhost:5678/webhook/lemut-router-webhook/webhook"
SECRET = "LemutRouter0001A_node-trigger"
CHAT_ID = int(os.environ.get("CHAT_ID", "8505920626"))
NOMBRE = os.environ.get("CHAT_NOMBRE", "Richer")

_uid = int(time.time() * 10) % 1_000_000_000


def psql(sql):
    out = subprocess.run(
        ["docker", "exec", "lemut_n8n-postgres-1", "psql", "-U", "lemut",
         "-d", "lemut_db", "-t", "-A", "-c", sql],
        capture_output=True, text=True, check=True)
    return out.stdout.strip()


UNFLATTEN_JS = r"""
const { parse } = require('/usr/local/lib/node_modules/n8n/node_modules/flatted');
let raw = '';
process.stdin.on('data', d => raw += d).on('end', () => {
  const out = [];
  try {
    const data = parse(raw);
    const rd = data.resultData ?? {};
    if (rd.error) out.push({ tipo: 'error', detalle: rd.error.message ?? String(rd.error) });
    for (const [nodo, runs] of Object.entries(rd.runData ?? {})) {
      for (const r of runs ?? []) {
        if (r.error) out.push({ tipo: 'error', nodo, detalle: r.error.message ?? String(r.error) });
        for (const rama of r.data?.main ?? []) {
          for (const it of rama ?? []) {
            const j = it?.json;
            if (j && j.ok === true && j.result && (j.result.text || j.result.chat)) {
              out.push({ tipo: 'enviado', nodo, chat_id: j.result.chat?.id,
                         text: j.result.text ?? '(sin texto)',
                         botones: j.result.reply_markup?.inline_keyboard?.flat()?.map(b => b.callback_data ? `${b.text} [${b.callback_data}]` : b.text) });
            }
          }
        }
      }
    }
  } catch (e) { out.push({ tipo: 'error', detalle: 'unflatten: ' + e.message }); }
  console.log(JSON.stringify(out));
});
"""


def extraer(exec_id):
    raw = psql(f'SELECT data FROM execution_data WHERE "executionId" = {exec_id};')
    p = subprocess.run(
        ["docker", "exec", "-i", "lemut_n8n-n8n-1", "node", "-e", UNFLATTEN_JS],
        input=raw, capture_output=True, text=True)
    try:
        return json.loads(p.stdout.strip())
    except Exception:
        return [{"tipo": "error", "detalle": f"no pude parsear exec {exec_id}: {p.stderr[:200]}"}]


def inyectar(update):
    req = urllib.request.Request(
        WEBHOOK, data=json.dumps(update).encode(),
        headers={"Content-Type": "application/json",
                 "X-Telegram-Bot-Api-Secret-Token": SECRET})
    with urllib.request.urlopen(req, timeout=30) as r:
        r.read()


def mandar(update, timeout=90):
    """Inyecta un update y regresa los eventos de las ejecuciones nuevas."""
    prev = int(psql("SELECT COALESCE(MAX(id), 0) FROM execution_entity;"))
    inyectar(update)
    fin = time.time() + timeout
    ejecuciones = []
    while time.time() < fin:
        filas = psql(
            f"SELECT id, status FROM execution_entity WHERE id > {prev} ORDER BY id;")
        ejecuciones = [f.split("|") for f in filas.splitlines() if f]
        if ejecuciones and all(s not in ("new", "running", "waiting") for _, s in ejecuciones):
            break
        time.sleep(1)
    eventos = []
    for eid, status in ejecuciones:
        for ev in extraer(eid):
            ev["exec"] = int(eid)
            ev["status"] = status
            eventos.append(ev)
    if not ejecuciones:
        eventos.append({"tipo": "error", "detalle": "no se disparó ninguna ejecución"})
    return eventos


def upd_texto(texto):
    global _uid
    _uid += 1
    return {"update_id": _uid, "message": {
        "message_id": _uid, "date": int(time.time()),
        "from": {"id": CHAT_ID, "is_bot": False, "first_name": NOMBRE},
        "chat": {"id": CHAT_ID, "first_name": NOMBRE, "type": "private"},
        "text": texto}}


def upd_callback(data):
    global _uid
    _uid += 1
    return {"update_id": _uid, "callback_query": {
        "id": f"sim{_uid}", "chat_instance": f"ci{CHAT_ID}", "data": data,
        "from": {"id": CHAT_ID, "is_bot": False, "first_name": NOMBRE},
        "message": {"message_id": _uid, "date": int(time.time()),
                    "chat": {"id": CHAT_ID, "first_name": NOMBRE, "type": "private"}}}}


def upd_contact(telefono):
    global _uid
    _uid += 1
    return {"update_id": _uid, "message": {
        "message_id": _uid, "date": int(time.time()),
        "from": {"id": CHAT_ID, "is_bot": False, "first_name": NOMBRE},
        "chat": {"id": CHAT_ID, "first_name": NOMBRE, "type": "private"},
        "contact": {"phone_number": telefono, "first_name": NOMBRE, "user_id": CHAT_ID}}}


def imprimir(eventos):
    for ev in eventos:
        if ev["tipo"] == "enviado":
            print(f"  🤖 [{ev['nodo']}] → chat {ev.get('chat_id')}:")
            for linea in ev["text"].splitlines():
                print(f"     {linea}")
            if ev.get("botones"):
                print(f"     Botones: {ev['botones']}")
        else:
            print(f"  💥 ERROR ({ev.get('nodo', 'workflow')} · exec {ev.get('exec')}): {ev['detalle'][:300]}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    if args[0] == "--cb":
        u = upd_callback(args[1])
    elif args[0] == "--contact":
        u = upd_contact(args[1])
    else:
        u = upd_texto(" ".join(args))
    imprimir(mandar(u))
