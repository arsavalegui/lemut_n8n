#!/usr/bin/env python3
"""Suite E2E del bot: simula una conversación completa de Telegram
(cliente + admin en el mismo chat) y valida las respuestas reales.

Recorre: RAG (hola, precios, barberos) → registro de admin → flujo de
agendado completo hasta cita confirmada con noti al gerente → comandos
de admin con la cita → carrera por el mismo hueco → /cancelar.

OJO: agenda una cita real en la BD (cliente "Richer", tel +5215512345678).
Correr desde la raíz del repo:  python3 scripts/test_e2e.py
"""
import datetime as dt
import sys

from sim_telegram import mandar, psql, upd_texto, upd_callback, upd_contact, imprimir

TEL_PRUEBA = "+5215512345678"


def dia_prueba():
    """Día laboral de Diego dentro de la ventana de 7 días del motor:
    mañana, o el lunes si mañana cae en domingo."""
    d = dt.date.today() + dt.timedelta(days=1)
    if d.weekday() == 6:
        d += dt.timedelta(days=1)
    return d.isoformat()


DIA = dia_prueba()
ETIQ_DIA = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"][dt.date.fromisoformat(DIA).weekday()]

# Limpieza para que la suite sea re-corrible: borra admins, estado y las
# citas de prueba anteriores (identificadas por el teléfono de prueba).
print("Limpiando datos de corridas anteriores...")
psql("DELETE FROM agenda.conversation_state;")
psql("DELETE FROM agenda.admins;")
psql(f"DELETE FROM agenda.bookings WHERE cliente_telefono = '{TEL_PRUEBA}';")

fallos = []
paso_n = 0


def paso(descripcion, update, esperado=None, no_esperado=None):
    global paso_n
    paso_n += 1
    print(f"\n━━ Paso {paso_n}: {descripcion}")
    eventos = mandar(update)
    imprimir(eventos)
    textos = "\n".join(e.get("text", "") + " " + " ".join(e.get("botones") or [])
                       for e in eventos if e["tipo"] == "enviado")
    errores = [e for e in eventos if e["tipo"] == "error"]
    ok = True
    for patron in (esperado or []):
        if patron.lower() not in textos.lower():
            ok = False
            fallos.append(f"paso {paso_n} ({descripcion}): esperaba «{patron}»")
    for patron in (no_esperado or []):
        if patron.lower() in textos.lower():
            ok = False
            fallos.append(f"paso {paso_n} ({descripcion}): NO esperaba «{patron}»")
    if errores:
        ok = False
        fallos.append(f"paso {paso_n} ({descripcion}): errores {[e['detalle'][:120] for e in errores]}")
    print("  ✅ OK" if ok else "  ❌ FALLÓ")
    return textos


# --- RAG ---
paso("hola (presentación del negocio)", upd_texto("hola"),
     esperado=["Rincón del Corte"])
paso("precio de un servicio", upd_texto("¿cuánto cuesta el corte de cabello?"),
     esperado=["180"])
paso("pregunta por los barberos", upd_texto("¿qué barberos tienen?"),
     esperado=["Luis", "Diego", "Miguel"])
paso("pregunta fuera del doc", upd_texto("¿quién ganó el mundial de 2022?"),
     esperado=["Solo puedo ayudarte con temas relacionados al negocio"])

# --- Admin: registro ---
paso("/soyadmin con código malo", upd_texto("/soyadmin 111111"),
     esperado=["Código incorrecto"])
paso("/hoy sin ser admin", upd_texto("/hoy"),
     esperado=["No estás autorizado"])
paso("/soyadmin con código bueno", upd_texto("/soyadmin 957276"),
     esperado=["registrado como admin"])
paso("/hoy ya como admin (sin citas)", upd_texto("/hoy"),
     esperado=["No hay citas para hoy"])

# --- Flujo de agendado completo ---
paso("quiero agendar una cita", upd_texto("quiero agendar una cita"),
     esperado=["Qué servicio", "svc|0"])
paso("elijo Corte de cabello (svc|0)", upd_callback("svc|0"),
     esperado=["Con qué barbero", "barb|1"])
paso("elijo Diego Torres (barb|1)", upd_callback("barb|1"),
     esperado=["Qué día", f"dia|{DIA}"])
textos = paso(f"elijo el {ETIQ_DIA} {DIA}", upd_callback(f"dia|{DIA}"),
              esperado=["Horarios libres", "hueco|13:00"],
              no_esperado=["hueco|11:00"])  # Diego entra a las 12:00
paso("elijo las 13:00", upd_callback("hueco|13:00"),
     esperado=["comparte tu teléfono"])
paso("comparto mi contacto → cita + noti al gerente", upd_contact(TEL_PRUEBA),
     esperado=["Cita confirmada", "Nueva cita agendada", TEL_PRUEBA])

# --- Admin: la cita aparece ---
paso("/agenda (todas las próximas)", upd_texto("/agenda"),
     esperado=["Diego Torres", "13:00", "Richer"])
paso("/agenda Diego (filtrada)", upd_texto("/agenda Diego"),
     esperado=["Diego Torres"])
paso("/agenda Luis (sin citas)", upd_texto("/agenda Luis"),
     esperado=["No hay citas próximas"])

# --- Carrera por el mismo hueco ---
paso("otro cliente quiere agendar", upd_texto("agendar"),
     esperado=["Qué servicio"])
paso("mismo servicio (svc|0)", upd_callback("svc|0"), esperado=["barbero"])
paso("mismo barbero (barb|1)", upd_callback("barb|1"), esperado=["Qué día"])
paso(f"mismo día: las 13:00 ya NO deben ofrecerse", upd_callback(f"dia|{DIA}"),
     esperado=["Horarios libres"], no_esperado=["hueco|13:00"])
paso("fuerzo tap en botón viejo de las 13:00 (carrera)", upd_callback("hueco|13:00"),
     esperado=["comparte tu teléfono"])
paso("comparto contacto → debe rechazar por hueco ocupado", upd_contact(TEL_PRUEBA),
     esperado=["se acaba de ocupar"], no_esperado=["Cita confirmada"])

# --- Interrupciones ---
paso("empiezo a agendar de nuevo", upd_texto("quiero una cita"),
     esperado=["Qué servicio"])
paso("pregunto otra cosa a media agenda", upd_texto("¿cuánto cuesta el tinte?"),
     esperado=["Estás agendando", "/cancelar"])
paso("/cancelar", upd_texto("/cancelar"),
     esperado=["cancelé"])
paso("después de cancelar, el RAG vuelve a responder", upd_texto("¿a qué hora abren los sábados?"),
     esperado=["9"])

print("\n" + "═" * 50)
if fallos:
    print(f"❌ {len(fallos)} FALLOS de {paso_n} pasos:")
    for f in fallos:
        print(" -", f)
    sys.exit(1)
print(f"✅ TODOS LOS {paso_n} PASOS PASARON")
