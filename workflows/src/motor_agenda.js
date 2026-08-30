// Motor de agenda por LENGUAJE NATURAL (sin botones).
//   El cliente escribe "quiero cita el próximo lunes a las 10am con Diego para
//   corte" y el motor extrae servicio/barbero/fecha/hora con un LLM (Ollama
//   local), valida contra el doc del negocio, pide en lenguaje natural lo que
//   falte (nombre y teléfono siempre), y agenda. La disponibilidad la garantiza
//   el INSERT atómico; aquí solo pre-validamos horario y traslape para buena UX.
//
// Fuente editable; se embebe en agenda_cliente.json con scripts/embed_motor.py.
// Entradas (nodos previos):
//   $('Entrada')       → update de Telegram
//   $('Leer estado')   → fila de conversation_state
//   $('Leer citas')    → TODAS las citas confirmadas futuras (para traslape)
//   $('Leer mis citas')→ citas del propio chat (para "mis citas")
//   $('Extraer texto') → doc del negocio
// Salida: { chat_id, payloads, state_op, booking, cancel_op }

const upd = $('Entrada').first().json;
const estadoRow = $('Leer estado').first()?.json ?? {};
const citas = $('Leer citas').all().map(i => i.json).filter(c => c.trabajador);
const doc = $('Extraer texto').first().json.data ?? '';

const msg = upd.message ?? {};
const chatId = msg.chat?.id ?? upd.callback_query?.message?.chat?.id;
const texto = (msg.text ?? '').trim();

// ---------- parseo del doc ----------
function parseServicios(md) {
  const out = [];
  for (const linea of md.split('\n')) {
    const c = linea.split('|').map(x => x.trim());
    if (c.length >= 4 && /^\d+\s*min$/.test(c[2] ?? ''))
      out.push({ nombre: c[1], dur: parseInt(c[2], 10), precio: c[3] });
  }
  return out;
}
function parseHorarios(md) {
  const sec = md.split(/^## Horarios por trabajador$/m)[1]?.split(/^## /m)[0] ?? '';
  const h = {};
  const dows = [1, 2, 3, 4, 5, 6, 0];
  for (const linea of sec.split('\n')) {
    const c = linea.split('|').map(x => x.trim());
    if (c.length < 9 || c[1] === 'Barbero' || /^[-\s:]*$/.test(c[1])) continue;
    const dia = {};
    dows.forEach((dow, i) => {
      const m = (c[2 + i] ?? '').match(/(\d{2}:\d{2})\s*[–-]\s*(\d{2}:\d{2})/);
      dia[dow] = m ? [m[1], m[2]] : null;
    });
    h[c[1]] = dia;
  }
  return h;
}
function parsePoliticas(md) {
  const sec = md.split(/^## Políticas$/m)[1]?.split(/^## /m)[0] ?? '';
  return sec.split('\n')
    .filter(l => /^\s*-\s/.test(l) && /(puntualidad|tarde|toleranc|cancelaci)/i.test(l))
    .map(l => l.replace(/^\s*-\s*/, '').replace(/\*\*/g, '').trim());
}

const servicios = parseServicios(doc);
const horarios = parseHorarios(doc);
const barberos = Object.keys(horarios);
const politicasClave = parsePoliticas(doc);

// ---------- fecha/hora ----------
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS_LARGO = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function aMin(h) { const [a, b] = h.split(':').map(Number); return a * 60 + b; }
function aHHMM(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function ahoraCDMX() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })); }
function fechaISO(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function etiquetaISO(iso) { const d = new Date(iso + 'T12:00:00'); return `${DIAS_LARGO[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`; }

// Resuelve fechas relativas en español DE FORMA DETERMINISTA (el LLM chico
// falla con aritmética de fechas). Devuelve ISO o null si no reconoce.
function resolverFechaTexto(txt, hoy) {
  const t = txt.toLowerCase();
  const base = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const iso = d => fechaISO(d);
  const mas = n => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
  if (/\bpasado\s+ma[ñn]ana\b/.test(t)) return iso(mas(2));
  if (/\bma[ñn]ana\b/.test(t)) return iso(mas(1));
  if (/\bhoy\b/.test(t)) return iso(base);
  const nombres = { 'domingo': 0, 'lunes': 1, 'martes': 2, 'miercoles': 3, 'miércoles': 3, 'jueves': 4, 'viernes': 5, 'sabado': 6, 'sábado': 6 };
  for (const [nom, dow] of Object.entries(nombres)) {
    if (new RegExp(`\\b${nom}\\b`).test(t)) {
      const d = new Date(base);
      let delta = (dow - d.getDay() + 7) % 7;
      // "próximo/siguiente" o si cae hoy → la semana que viene; si no, el más cercano futuro
      if (delta === 0) delta = 7;
      if (/\b(pr[oó]ximo|siguiente|entrante)\b/.test(t) && delta < 7) { /* ya es el próximo */ }
      d.setDate(d.getDate() + delta);
      return iso(d);
    }
  }
  // "el 5 de septiembre" / "5 de sep"
  const m = t.match(/\b(\d{1,2})\s+de\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)/);
  if (m) {
    const mes = MESES.indexOf(m[2]);
    let y = hoy.getFullYear();
    let d = new Date(y, mes, +m[1]);
    if (d < base) d = new Date(y + 1, mes, +m[1]);
    return iso(d);
  }
  return null;
}

// ---------- salida ----------
const payloads = [];
let stateOp = { action: 'none', state: '-', ctxB64: 'e30=' };
let booking = {
  action: 'none', trabajador: '-', servicio: '-', dur: 0, fecha: '1970-01-01',
  ini: '00:00', fin: '00:00', nombreB64: 'LQ==', telefono: '-', cliente_chat_id: 0,
  fechaEtiqueta: '-', politicas: [],
};
let cancelOp = { action: 'none', id: 0 };
function enviar(t) { payloads.push({ method: 'sendMessage', body: { chat_id: chatId, text: t } }); }
function setEstado(ctx) { stateOp = { action: 'set', state: 'agendando', ctxB64: Buffer.from(JSON.stringify(ctx)).toString('base64') }; }
function limpiarEstado() { stateOp = { action: 'clear', state: '-', ctxB64: 'e30=' }; }

const state = estadoRow.state ?? null;
const ctx = (estadoRow.context_json && typeof estadoRow.context_json === 'object') ? estadoRow.context_json : {};

// ---------- extracción con LLM (Ollama local) ----------
async function extraer(mensaje, ctxPrevio) {
  const hoy = ahoraCDMX();
  const sys = [
    'Eres un extractor de datos para agendar citas en una barbería. Del mensaje del cliente extrae SOLO lo que diga, sin inventar.',
    `Hoy es ${fechaISO(hoy)} (${DIAS_LARGO[hoy.getDay()]}). Zona horaria America/Mexico_City.`,
    `Servicios válidos: ${servicios.map(s => s.nombre).join('; ')}.`,
    `Barberos válidos: ${barberos.join('; ')}.`,
    'Devuelve SOLO un JSON con estas claves (omite o pon null las que el cliente no mencione):',
    '{"servicio": "<nombre exacto de un servicio válido o null>",',
    ' "barbero": "<nombre exacto de un barbero válido, o \\"cualquiera\\" si no le importa, o null>",',
    ' "fecha": "<YYYY-MM-DD resolviendo fechas relativas respecto a hoy: mañana, pasado mañana, próximo lunes, este viernes, etc.>",',
    ' "hora": "<HH:MM en 24h, ej. 10am=10:00, 3pm=15:00>",',
    ' "nombre": "<nombre completo de la persona si lo da>",',
    ' "telefono": "<teléfono si lo da, solo dígitos>"}',
    'No incluyas texto fuera del JSON.',
  ].join('\n');
  const user = `Contexto ya conocido: ${JSON.stringify(ctxPrevio)}\nMensaje del cliente: "${mensaje}"`;
  try {
    const r = await this.helpers.httpRequest({
      method: 'POST',
      url: 'http://host.docker.internal:11434/v1/chat/completions',
      body: {
        model: 'qwen2.5:3b-instruct', stream: false, temperature: 0,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      },
      json: true, timeout: 60000,
    });
    const cont = r.choices?.[0]?.message?.content ?? '{}';
    const m = cont.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : {};
  } catch (e) {
    return { _error: String(e) };
  }
}

// ---------- normalización/validación ----------
function matchServicio(nombre) {
  if (!nombre) return null;
  const n = nombre.toLowerCase();
  return servicios.find(s => s.nombre.toLowerCase() === n)
    || servicios.find(s => s.nombre.toLowerCase().includes(n) || n.includes(s.nombre.toLowerCase()))
    || null;
}
function matchBarbero(nombre) {
  if (!nombre) return null;
  if (/cualquier|el que sea|no me importa/i.test(nombre)) return 'cualquiera';
  const n = nombre.toLowerCase();
  return barberos.find(b => b.toLowerCase() === n)
    || barberos.find(b => b.toLowerCase().includes(n) || n.includes(b.toLowerCase().split(' ')[0]))
    || null;
}
// ¿el barbero trabaja ese día y a esa hora cabe el servicio?
function horarioValido(barbero, fecha, hora, dur) {
  const d = new Date(fecha + 'T12:00:00');
  const rango = horarios[barbero]?.[d.getDay()];
  if (!rango) return { ok: false, motivo: `${barbero} no atiende el ${etiquetaISO(fecha)}` };
  const [abre, cierra] = rango.map(aMin);
  const t = aMin(hora);
  if (t < abre || t + dur > cierra)
    return { ok: false, motivo: `${barbero} atiende de ${rango[0]} a ${rango[1]} ese día` };
  return { ok: true };
}
function traslape(barbero, fecha, hora, dur) {
  const t = aMin(hora);
  return citas.some(c => c.trabajador === barbero && c.fecha_iso === fecha
    && t < aMin(c.fin) && t + dur > aMin(c.ini));
}
// primer barbero que puede a esa fecha/hora (para "cualquiera")
function barberoDisponible(fecha, hora, dur) {
  return barberos.find(b => horarioValido(b, fecha, hora, dur).ok && !traslape(b, fecha, hora, dur)) || null;
}

// ==================== FLUJO ====================
async function correr() {
  // 1) Cancelar (sin botones): flujo en curso o una cita ya agendada
  if (/^\/?cancelar\b/i.test(texto) || /\b(cancela|cancelar|olv[ií]dalo|ya no quiero)\b/i.test(texto)) {
    if (state === 'agendando') { limpiarEstado(); enviar('Listo, cancelé el agendado. ¿Te ayudo con algo más?'); return; }
    const mias = $('Leer mis citas').all().map(i => i.json).filter(c => c.id !== undefined);
    if (mias.length === 0) { enviar('No tienes citas para cancelar. ¿Te ayudo a agendar una?'); return; }
    if (mias.length === 1) { cancelOp = { action: 'cancel', id: mias[0].id }; return; }
    // varias: intenta emparejar por la fecha que mencionen (día del mes)
    const dia = (texto.match(/\b(\d{1,2})\b/) || [])[1];
    const match = dia ? mias.find(c => new Date(c.fecha_iso + 'T12:00:00').getDate() === +dia) : null;
    if (match) { cancelOp = { action: 'cancel', id: match.id }; return; }
    const l = mias.map(c => `• ${etiquetaISO(c.fecha_iso)} a las ${c.ini} con ${c.trabajador}`);
    enviar(`Tienes varias citas:\n\n${l.join('\n')}\n\n¿Cuál cancelo? Dime la fecha (por ejemplo "la del ${new Date(mias[0].fecha_iso + 'T12:00:00').getDate()}").`);
    return;
  }
  const pideMisCitas = (/\bmis?\s+citas?\b/i.test(texto) || /\bcitas?\s+(tengo|agendadas?)\b/i.test(texto)
    || /\bcu[aá]ndo\s+es\s+mi\s+cita\b/i.test(texto) || /^\/?miscitas\b/i.test(texto))
    && !/(agend|reserv|apart|quiero)/i.test(texto);
  if (pideMisCitas && state !== 'agendando') {
    const mias = $('Leer mis citas').all().map(i => i.json).filter(c => c.id !== undefined);
    if (mias.length === 0) enviar('No tienes citas próximas. Dime cuándo quieres una y te la agendo.');
    else {
      const l = mias.map(c => `• ${etiquetaISO(c.fecha_iso)} a las ${c.ini} — ${c.servicio} con ${c.trabajador}`);
      enviar(`Tus próximas citas:\n\n${l.join('\n')}\n\nSi quieres cancelar una, dime cuál (por ejemplo "cancela la del ${etiquetaISO(mias[0].fecha_iso)}").`);
    }
    return;
  }
  // Contacto nativo compartido (opcional, sigue sirviendo para el teléfono)
  let telDeContacto = null;
  if (msg.contact) {
    if (msg.contact.user_id && msg.from?.id && msg.contact.user_id !== msg.from.id) {
      enviar('Ese contacto no es tuyo. Mándame TU número (10 dígitos) para confirmar.'); return;
    }
    telDeContacto = (msg.contact.phone_number || '').replace(/\D/g, '').slice(-10);
  }

  // 2) Extraer con el LLM (a menos que solo haya mandado el contacto)
  let ext = {};
  if (texto) ext = await extraer.call(this, texto, ctx);

  // 3) Merge en el contexto
  const nuevo = { ...ctx };
  const svc = matchServicio(ext.servicio);
  if (svc) { nuevo.servicio = svc.nombre; nuevo.dur = svc.dur; }
  const barb = matchBarbero(ext.barbero);
  if (barb) nuevo.barbero = barb;
  // La fecha la resolvemos en código (determinista) desde el texto; el LLM
  // solo como respaldo si el texto no trae una expresión reconocible.
  const fechaJS = texto ? resolverFechaTexto(texto, ahoraCDMX()) : null;
  if (fechaJS) nuevo.fecha = fechaJS;
  else if (ext.fecha && /^\d{4}-\d{2}-\d{2}$/.test(ext.fecha)) nuevo.fecha = ext.fecha;
  if (ext.hora && /^\d{1,2}:\d{2}$/.test(ext.hora)) nuevo.hora = ext.hora.padStart(5, '0');
  if (ext.nombre && String(ext.nombre).trim().length >= 3 && /[a-záéíóúñ]/i.test(ext.nombre)) nuevo.nombre = String(ext.nombre).trim();
  const telExt = telDeContacto || (ext.telefono ? String(ext.telefono).replace(/\D/g, '') : '');
  if (telExt && telExt.length >= 10) nuevo.telefono = telExt.slice(-10);

  // ¿el usuario quiere agendar? (o ya está en flujo)
  const intencion = state === 'agendando' || /\b(agend|cita|reserv|apart|quiero|me gustar[ií]a)\b/i.test(texto)
    || svc || barb || nuevo.fecha !== ctx.fecha;
  if (!intencion) {
    enviar('Puedo ayudarte a agendar una cita. Dime, por ejemplo: "quiero corte el próximo lunes a las 10am".');
    return;
  }

  // 4) Validaciones de lo que ya tenemos
  if (nuevo.fecha) {
    const d = new Date(nuevo.fecha + 'T12:00:00');
    if (fechaISO(d) < fechaISO(ahoraCDMX())) { delete nuevo.fecha; delete nuevo.hora; }
  }
  // resolver "cualquiera" cuando ya hay fecha/hora/servicio
  if (nuevo.barbero === 'cualquiera' && nuevo.fecha && nuevo.hora && nuevo.dur) {
    const libre = barberoDisponible(nuevo.fecha, nuevo.hora, nuevo.dur);
    if (libre) nuevo.barbero = libre;
  }

  // 5) ¿Qué falta? (nombre y teléfono SIEMPRE requeridos)
  setEstado(nuevo);
  if (!nuevo.servicio) { enviar(resumenParcial(nuevo) + '¿Qué servicio quieres? Por ejemplo: ' + servicios.slice(0, 3).map(s => s.nombre).join(', ') + '…'); return; }
  if (!nuevo.barbero) { enviar(resumenParcial(nuevo) + `¿Con qué barbero? Tenemos a ${barberos.join(', ')} (o dime "el que sea").`); return; }
  if (!nuevo.fecha) { enviar(resumenParcial(nuevo) + '¿Para qué día la quieres?'); return; }
  if (!nuevo.hora) { enviar(resumenParcial(nuevo) + '¿A qué hora?'); return; }

  // validar horario del barbero elegido
  if (nuevo.barbero !== 'cualquiera') {
    const v = horarioValido(nuevo.barbero, nuevo.fecha, nuevo.hora, nuevo.dur);
    if (!v.ok) { delete nuevo.hora; setEstado(nuevo); enviar(`Uy, ${v.motivo}. ¿Qué otra hora te acomoda?`); return; }
    if (traslape(nuevo.barbero, nuevo.fecha, nuevo.hora, nuevo.dur)) {
      delete nuevo.hora; setEstado(nuevo);
      enviar(`Esa hora ya está ocupada con ${nuevo.barbero} el ${etiquetaISO(nuevo.fecha)}. ¿Otra hora?`); return;
    }
  }

  if (!nuevo.nombre) { setEstado(nuevo); enviar(resumenCita(nuevo) + '¿A nombre de quién agendo la cita? (nombre completo)'); return; }
  if (!nuevo.telefono) { setEstado(nuevo); enviar(resumenCita(nuevo) + `Perfecto, ${nuevo.nombre}. Por último, ¿me compartes tu teléfono (10 dígitos)?`); return; }

  // 6) Todo listo → reservar (el INSERT atómico decide disponibilidad final)
  booking = {
    action: 'book', trabajador: nuevo.barbero, servicio: nuevo.servicio, dur: nuevo.dur,
    fecha: nuevo.fecha, ini: nuevo.hora, fin: aHHMM(aMin(nuevo.hora) + nuevo.dur),
    nombreB64: Buffer.from(nuevo.nombre).toString('base64'), telefono: nuevo.telefono,
    cliente_chat_id: chatId, fechaEtiqueta: etiquetaISO(nuevo.fecha), politicas: politicasClave,
  };
  // Resolver reserva arma la confirmación/aviso y limpia el estado.
}

function resumenParcial(c) {
  const p = [];
  if (c.servicio) p.push(c.servicio);
  if (c.barbero && c.barbero !== 'cualquiera') p.push('con ' + c.barbero);
  if (c.fecha) p.push(etiquetaISO(c.fecha));
  if (c.hora) p.push('a las ' + c.hora);
  return p.length ? `Voy anotando: ${p.join(', ')}.\n` : '';
}
function resumenCita(c) {
  return `Va quedando:\nServicio: ${c.servicio}\nBarbero: ${c.barbero}\nFecha: ${etiquetaISO(c.fecha)} a las ${c.hora}\n\n`;
}

return correr().then(() => [{ json: { chat_id: chatId, payloads, state_op: stateOp, booking, cancel_op: cancelOp } }]);
