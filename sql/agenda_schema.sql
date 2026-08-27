-- Fase agenda — esquema de datos (Fase A)
-- Vive en el schema "agenda" para no mezclarse con las tablas internas
-- de n8n (que usan "public"). Aplicar con:
--   docker exec -i lemut_n8n-postgres-1 psql -U lemut -d lemut_db < sql/agenda_schema.sql

CREATE SCHEMA IF NOT EXISTS agenda;

-- Gerentes/admins del negocio. Se dan de alta con /soyadmin CODIGO.
CREATE TABLE IF NOT EXISTS agenda.admins (
  chat_id    BIGINT PRIMARY KEY,
  nombre     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Citas agendadas por clientes vía Telegram.
CREATE TABLE IF NOT EXISTS agenda.bookings (
  id               SERIAL PRIMARY KEY,
  trabajador       TEXT NOT NULL,
  servicio         TEXT NOT NULL,
  duracion_min     INTEGER NOT NULL,
  fecha            DATE NOT NULL,
  hora_inicio      TIME NOT NULL,
  hora_fin         TIME NOT NULL,
  cliente_nombre   TEXT NOT NULL,
  cliente_telefono TEXT NOT NULL,
  cliente_chat_id  BIGINT NOT NULL,
  -- confirmada | cancelada
  estado           TEXT NOT NULL DEFAULT 'confirmada',
  reminder_sent    BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Consultas típicas: agenda del día y agenda por barbero.
CREATE INDEX IF NOT EXISTS bookings_fecha_idx
  ON agenda.bookings (fecha, trabajador);

-- Red de seguridad contra double-booking exacto (mismo barbero, misma
-- fecha y hora, ambas confirmadas). El INSERT del workflow además usa
-- WHERE NOT EXISTS para traslapes parciales.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_slot_unico_idx
  ON agenda.bookings (trabajador, fecha, hora_inicio)
  WHERE estado = 'confirmada';

-- Estado de la conversación de agendado (state machine multi-paso).
CREATE TABLE IF NOT EXISTS agenda.conversation_state (
  chat_id      BIGINT PRIMARY KEY,
  state        TEXT NOT NULL,
  context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
