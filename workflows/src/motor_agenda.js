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
// Última fila de todo menú del flujo: salida sin fricción.
function conCancelar(filas) {
  return [...filas, [{ text: 'Cancelar', callback_data: 'abort|1' }]];
}

// ---------- state machine ----------

const payloads = [];
// 'state' nunca viaja vacío: n8n descarta parámetros '' en queryReplacement.
let stateOp = { action: 'none', state: '-', ctxB64: 'e30=' };
// Intento de reserva (Fase C). El INSERT lo hace el nodo "Insertar cita"
// (gateado por action='book') y "Resolver reserva" arma los mensajes según
// si la fila entró o el hueco ya estaba tomado. Los dummies son casteables
// porque Postgres los parsea aunque el WHERE los descarte.
let booking = {
  action: 'none', trabajador: '-', servicio: '-', dur: 0,
  fecha: '1970-01-01', ini: '00:00', fin: '00:00',
  nombreB64: 'LQ==', telefono: '-', cliente_chat_id: 0, fechaEtiqueta: '-',
};
// Cancelación de cita (Fase E). El UPDATE lo hace el nodo "Cancelar cita"
// (gateado por action='cancel') y Resolver arma los mensajes.
let cancelOp = { action: 'none', id: 0 };

function enviar(textoMsg, teclado) {
  const body = { chat_id: chatId, text: textoMsg };
  if (Array.isArray(teclado)) body.reply_markup = { inline_keyboard: teclado };
  else if (teclado === 'contacto') body.reply_markup = {
    keyboard: [[{ text: 'Compartir mi teléfono', request_contact: true }], [{ text: 'Cancelar' }]],
    one_time_keyboard: true, resize_keyboard: true,
  };
  else if (teclado === 'quitar') body.reply_markup = { remove_keyboard: true };
  payloads.push({ method: 'sendMessage', body });
}
function setEstado(state, ctx) {
  stateOp = { action: 'set', state, ctxB64: Buffer.from(JSON.stringify(ctx)).toString('base64') };
}
function limpiarEstado() { stateOp = { action: 'clear', state: '-', ctxB64: 'e30=' }; }

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
    enviar(`Va: ${s.nombre} (${s.dur} min). ¿Con qué barbero?`, conCancelar(tecladoBarberos()));
  } else if (tipo === 'barb' && state === 'barbero' && barberos[+valor]) {
    const b = barberos[+valor];
    setEstado('dia', { ...ctx, barbero: b });
    enviar(`¿Qué día quieres tu cita con ${b}?`, conCancelar(tecladoDias(b)));
  } else if (tipo === 'dia' && state === 'dia' && !diasDisponibles(ctx.barbero).map(fechaISO).includes(valor)) {
    // Botón de un día que ya salió de la ventana de 7 días (o data inventada).
    enviar(`Ese día ya no está disponible. Elige uno de estos:`, conCancelar(tecladoDias(ctx.barbero)));
  } else if (tipo === 'dia' && state === 'dia') {
    const hs = calcularHuecos(ctx.barbero, valor, ctx.dur ?? 30);
    if (hs.length === 0) {
      enviar(`El ${etiquetaISO(valor)} ${ctx.barbero} ya no tiene huecos para ${ctx.servicio}. Elige otro día:`, conCancelar(tecladoDias(ctx.barbero)));
    } else {
      setEstado('hueco', { ...ctx, fecha: valor });
      enviar(`Horarios libres de ${ctx.barbero} el ${etiquetaISO(valor)} para ${ctx.servicio}:`, conCancelar(tecladoHuecos(hs)));
    }
  } else if (tipo === 'hueco' && state === 'hueco') {
    // El nombre se pregunta aparte porque en Telegram mucha gente usa
    // apodos; el negocio necesita el nombre real de quien llega.
    setEstado('nombre', { ...ctx, hora: valor });
    enviar(`Va quedando:\n\nServicio: ${ctx.servicio}\nBarbero: ${ctx.barbero}\nFecha: ${etiquetaISO(ctx.fecha)} a las ${valor}\n\n¿A nombre de quién agendo la cita? Escríbeme el nombre completo (o escribe cancelar para salir).`);
  } else if (tipo === 'abort') {
    limpiarEstado();
    enviar('Listo, cancelé el proceso de agendado. ¿Te ayudo con algo más?', 'quitar');
  } else if (tipo === 'cxl') {
    // Cancelar una cita desde /miscitas. Funciona en cualquier estado;
    // la validación (que sea suya, futura y confirmada) va en el SQL.
    cancelOp = { action: 'cancel', id: parseInt(valor, 10) || 0 };
  } else {
    enviar('Ese menú ya venció. Escribe "agendar" para empezar de nuevo.');
  }
} else if (/^\/miscitas\b/i.test(texto)) {
  const mias = $('Leer mis citas').all().map(i => i.json).filter(c => c.id !== undefined);
  if (mias.length === 0) {
    enviar('No tienes citas próximas. Escribe "agendar" si quieres apartar una.');
  } else {
    const lineas = mias.map(c => `• ${etiquetaISO(c.fecha_iso)} ${c.ini} — ${c.servicio} con ${c.trabajador}`);
    const botones = mias.map(c => [{
      text: `Cancelar ${etiquetaISO(c.fecha_iso)} ${c.ini}`,
      callback_data: `cxl|${c.id}`,
    }]);
    enviar(`Tus próximas citas:\n\n${lineas.join('\n')}\n\nSi necesitas cancelar alguna, usa los botones:`, botones);
  }
} else if (/^\/?cancelar\b/i.test(texto)) {
  limpiarEstado();
  enviar(state
    ? 'Listo, cancelé el proceso de agendado. ¿Te ayudo con algo más?'
    : 'No tenías ningún agendado en curso. ¿Te ayudo con algo más?', 'quitar');
} else if (state === 'nombre') {
  const nombre = texto.replace(/\s+/g, ' ').trim();
  if (nombre.length < 3 || nombre.length > 60 || nombre.startsWith('/')
      || !/[a-záéíóúñü]/i.test(nombre)) {
    enviar('Mmm, eso no parece un nombre. Escríbeme el nombre completo de quien viene a la cita (por ejemplo: Juan Pérez).');
  } else {
    setEstado('telefono', { ...ctx, nombre });
    enviar(`¡Gracias, ${nombre}! Ahora comparte tu teléfono con el botón de aquí abajo para confirmar tu cita.`, 'contacto');
  }
} else if (upd.message?.contact && state === 'telefono') {
  const contacto = upd.message.contact;
  if (contacto.user_id && upd.message.from?.id && contacto.user_id !== upd.message.from.id) {
    // Contacto reenviado de otra persona: el teléfono debe ser del propio cliente.
    enviar('Ese contacto no es tuyo. Usa el botón "Compartir mi teléfono" para mandar tu propio número.', 'contacto');
  } else {
    const nombre = ctx.nombre
      || [contacto.first_name, contacto.last_name].filter(Boolean).join(' ')
      || 'Cliente';
    booking = {
      action: 'book',
      trabajador: ctx.barbero,
      servicio: ctx.servicio,
      dur: ctx.dur,
      fecha: ctx.fecha,
      ini: ctx.hora,
      fin: aHHMM(aMin(ctx.hora) + ctx.dur),
      nombreB64: Buffer.from(nombre).toString('base64'),
      telefono: contacto.phone_number ?? '-',
      cliente_chat_id: chatId,
      fechaEtiqueta: etiquetaISO(ctx.fecha),
    };
    // Los mensajes y la limpieza de estado los decide "Resolver reserva"
    // según el resultado del INSERT (hueco libre vs recién ocupado).
  }
} else if (state === 'telefono') {
  enviar('Para confirmar tu cita comparte tu teléfono con el botón "Compartir mi teléfono" que te mandé, o toca Cancelar para salir.', 'contacto');
} else if (!state) {
  setEstado('servicio', {});
  enviar('¡Va! Vamos a agendar tu cita. ¿Qué servicio quieres?', conCancelar(tecladoServicios()));
} else {
  enviar('Estás agendando una cita. Elige una opción del último menú que te mandé, toca el botón Cancelar, o escribe cancelar para salir.');
}

return [{ json: { chat_id: chatId, payloads, state_op: stateOp, booking, cancel_op: cancelOp } }];
