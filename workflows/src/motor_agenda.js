// Motor de la agenda de citas (Fase B): state machine
//   servicio → barbero → día → hueco
// Corre dentro del nodo Code "Motor de agenda" del workflow Agenda Cliente.
// Este archivo es la FUENTE; scripts/embed_motor.py lo inyecta en
// workflows/agenda_cliente.json. Si editas el motor, edita AQUÍ y re-embebe.
//
// Entradas (nodos previos del workflow):
//   $('Entrada')       → update crudo de Telegram (message o callback_query)
//   $('Leer estado')   → fila de agenda.conversation_state (o item vacío)
//   $('Leer citas')    → citas confirmadas del barbero/fecha en juego
//   $('Extraer texto') → texto completo del doc del negocio (knowledge/*.md)
// Salida: un item { chat_id, payloads: [{method, body}], state_op }

const upd = $('Entrada').first().json;
const estadoRow = $('Leer estado').first()?.json ?? {};
const citas = $('Leer citas').all().map(i => i.json).filter(c => c.ini);
const doc = $('Extraer texto').first().json.data ?? '';

const cb = upd.callback_query ?? null;
const msg = cb ? cb.message : upd.message;
const chatId = msg?.chat?.id;
const texto = (upd.message?.text ?? '').trim();

// ---------- parseo del doc ----------

// Servicios: filas de la tabla "| nombre | 30 min | $180 MXN |"
function parseServicios(md) {
  const out = [];
  for (const linea of md.split('\n')) {
    const celdas = linea.split('|').map(c => c.trim());
    if (celdas.length >= 4 && /^\d+\s*min$/.test(celdas[2] ?? '')) {
      out.push({ nombre: celdas[1], dur: parseInt(celdas[2], 10), precio: celdas[3] });
    }
  }
  return out;
}

// Horarios: tabla de la sección "## Horarios por trabajador", columnas
// Lunes..Domingo. Devuelve { barbero: { dow: ['10:00','18:00'] | null } }
// con dow en formato getDay() de JS (0=domingo).
function parseHorarios(md) {
  const seccion = md.split(/^## Horarios por trabajador$/m)[1]?.split(/^## /m)[0] ?? '';
  const horarios = {};
  const mapaDow = [1, 2, 3, 4, 5, 6, 0]; // columnas Lunes..Domingo
  for (const linea of seccion.split('\n')) {
    const celdas = linea.split('|').map(c => c.trim());
    if (celdas.length < 9 || celdas[1] === 'Barbero' || /^[-\s:]*$/.test(celdas[1])) continue;
    const porDia = {};
    mapaDow.forEach((dow, i) => {
      const m = (celdas[2 + i] ?? '').match(/(\d{2}:\d{2})\s*[–-]\s*(\d{2}:\d{2})/);
      porDia[dow] = m ? [m[1], m[2]] : null;
    });
    horarios[celdas[1]] = porDia;
  }
  return horarios;
}

const servicios = parseServicios(doc);
const horarios = parseHorarios(doc);
const barberos = Object.keys(horarios);

// ---------- utilidades de fecha/hora ----------

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function aMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function aHHMM(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}
function fechaISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function etiquetaDia(d) { return `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`; }
function etiquetaISO(iso) { return etiquetaDia(new Date(iso + 'T12:00:00')); }

// Próximos 7 días (hoy incluido) en que trabaja el barbero.
function diasDisponibles(barbero) {
  const out = [];
  const hoy = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + i);
    if (horarios[barbero]?.[d.getDay()]) out.push(d);
  }
  return out;
}

// Huecos: inicios cada 30 min dentro del horario del barbero, que quepan
// completos antes del cierre y no se encimen con citas confirmadas.
// Si la fecha es hoy, sólo horarios con al menos 30 min de anticipación.
function calcularHuecos(barbero, fecha, dur) {
  const d = new Date(fecha + 'T12:00:00');
  const rango = horarios[barbero]?.[d.getDay()];
  if (!rango) return [];
  const [abre, cierra] = rango.map(aMin);
  const ahora = new Date();
  const minimo = fechaISO(ahora) === fecha ? ahora.getHours() * 60 + ahora.getMinutes() + 30 : 0;
  const ocupados = citas.map(c => [aMin(c.ini), aMin(c.fin)]);
  const out = [];
  for (let t = abre; t + dur <= cierra; t += 30) {
    if (t < minimo) continue;
    if (!ocupados.some(([i, f]) => t < f && t + dur > i)) out.push(aHHMM(t));
  }
  return out;
}

// ---------- teclados inline ----------

function tecladoServicios() {
  return servicios.map((s, i) => [{ text: `${s.nombre} — ${s.precio}`, callback_data: `svc|${i}` }]);
}
function tecladoBarberos() {
  return barberos.map((b, i) => [{ text: b, callback_data: `barb|${i}` }]);
}
function enFilas(botones, porFila) {
  const filas = [];
  for (let i = 0; i < botones.length; i += porFila) filas.push(botones.slice(i, i + porFila));
  return filas;
}
function tecladoDias(barbero) {
  return enFilas(diasDisponibles(barbero).map(d =>
    ({ text: etiquetaDia(d), callback_data: `dia|${fechaISO(d)}` })), 2);
}
function tecladoHuecos(hs) {
  return enFilas(hs.map(h => ({ text: h, callback_data: `hueco|${h}` })), 4);
}

// ---------- state machine ----------

const payloads = [];
let stateOp = { action: 'none', state: '', ctxB64: 'e30=' };

function enviar(textoMsg, teclado) {
  const body = { chat_id: chatId, text: textoMsg };
  if (teclado) body.reply_markup = { inline_keyboard: teclado };
  payloads.push({ method: 'sendMessage', body });
}
function setEstado(state, ctx) {
  stateOp = { action: 'set', state, ctxB64: Buffer.from(JSON.stringify(ctx)).toString('base64') };
}
function limpiarEstado() { stateOp = { action: 'clear', state: '', ctxB64: 'e30=' }; }

const state = estadoRow.state ?? null;
const ctx = (estadoRow.context_json && typeof estadoRow.context_json === 'object')
  ? estadoRow.context_json : {};

if (cb) {
  // Quitar el "relojito" del botón tocado.
  payloads.push({ method: 'answerCallbackQuery', body: { callback_query_id: cb.id } });
  const [tipo, valor] = (cb.data ?? '').split('|');

  if (tipo === 'svc' && state === 'servicio' && servicios[+valor]) {
    const s = servicios[+valor];
    setEstado('barbero', { ...ctx, servicio: s.nombre, dur: s.dur });
    enviar(`Va: ${s.nombre} (${s.dur} min).\n¿Con qué barbero?`, tecladoBarberos());
  } else if (tipo === 'barb' && state === 'barbero' && barberos[+valor]) {
    const b = barberos[+valor];
    setEstado('dia', { ...ctx, barbero: b });
    enviar(`¿Qué día quieres tu cita con ${b}?`, tecladoDias(b));
  } else if (tipo === 'dia' && state === 'dia') {
    const hs = calcularHuecos(ctx.barbero, valor, ctx.dur ?? 30);
    if (hs.length === 0) {
      enviar(`El ${etiquetaISO(valor)} ${ctx.barbero} ya no tiene huecos para ${ctx.servicio}. Elige otro día:`, tecladoDias(ctx.barbero));
    } else {
      setEstado('hueco', { ...ctx, fecha: valor });
      enviar(`Horarios libres de ${ctx.barbero} el ${etiquetaISO(valor)} para ${ctx.servicio}:`, tecladoHuecos(hs));
    }
  } else if (tipo === 'hueco' && state === 'hueco') {
    limpiarEstado();
    enviar(`🚧 Elegiste las ${valor} del ${etiquetaISO(ctx.fecha)} con ${ctx.barbero} — ¡buena elección! La confirmación de la cita (con tu teléfono) se habilita en la siguiente fase, así que aún NO quedó guardada.`);
  } else {
    enviar('Ese menú ya venció. Escribe "agendar" para empezar de nuevo.');
  }
} else if (/^\/cancelar\b/i.test(texto)) {
  limpiarEstado();
  enviar(state
    ? 'Listo, cancelé el proceso de agendado. ¿Te ayudo con algo más?'
    : 'No tenías ningún agendado en curso. ¿Te ayudo con algo más?');
} else if (!state) {
  setEstado('servicio', {});
  enviar('¡Va! Vamos a agendar tu cita. ¿Qué servicio quieres?', tecladoServicios());
} else {
  enviar('Estás agendando una cita — elige una opción del último menú que te mandé, o escribe /cancelar para salir.');
}

return [{ json: { chat_id: chatId, payloads, state_op: stateOp } }];
