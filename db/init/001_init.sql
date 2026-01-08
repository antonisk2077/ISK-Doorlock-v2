-- ========= USERS =========
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('admin','superadmin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========= CHIPS (nomor chip + MAC address) =========
CREATE TABLE IF NOT EXISTS chips (
  id SERIAL PRIMARY KEY,
  chip_no VARCHAR(32) NOT NULL UNIQUE,
  mac VARCHAR(32) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========= DOORS =========
CREATE TABLE IF NOT EXISTS doors (
  id SERIAL PRIMARY KEY,
  floor SMALLINT NOT NULL CHECK (floor BETWEEN 1 AND 4),
  room_no VARCHAR(16) NOT NULL,
  chip_id INT NULL REFERENCES chips(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doors_floor ON doors(floor);

-- ========= COMMAND LOGS (ACK latency) =========
CREATE TABLE IF NOT EXISTS command_logs (
  id BIGSERIAL PRIMARY KEY,
  door_id INT NOT NULL REFERENCES doors(id) ON DELETE CASCADE,
  action VARCHAR(32) NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ack_at TIMESTAMPTZ NULL,
  latency_ms INT NULL
);

CREATE INDEX IF NOT EXISTS idx_cmdlogs_door_time ON command_logs(door_id, requested_at DESC);

-- ========= PING LOGS (health) =========
CREATE TABLE IF NOT EXISTS ping_logs (
  id BIGSERIAL PRIMARY KEY,
  door_id INT NOT NULL REFERENCES doors(id) ON DELETE CASCADE,
  ping_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pinglogs_door_time ON ping_logs(door_id, ping_at DESC);

-- ========= SCHEDULES =========
-- schedule dengan tanggal + jam buka + jam hingga
-- open_sent_at / close_sent_at untuk anti-double trigger
CREATE TABLE IF NOT EXISTS schedules (
  id BIGSERIAL PRIMARY KEY,
  door_id INT NOT NULL REFERENCES doors(id) ON DELETE CASCADE,
  schedule_date DATE NOT NULL,
  open_time TIME NOT NULL,
  close_time TIME NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  open_sent_at TIMESTAMPTZ NULL,
  close_sent_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_schedules_date ON schedules(schedule_date);
CREATE INDEX IF NOT EXISTS idx_schedules_door_date ON schedules(door_id, schedule_date);

-- ========= SESSION TABLE (connect-pg-simple) =========
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid");
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
