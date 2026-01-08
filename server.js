const express = require('express');
const path = require('path');
const mqtt = require('mqtt');
const pg = require('pg');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcrypt');
const { DateTime } = require('luxon');

const app = express();

// ====== CONFIG ======
const PORT = parseInt(process.env.PORT || '3000', 10);
const TZ = process.env.TZ || 'Asia/Jakarta';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL env');
  process.exit(1);
}

const FLOORS = (process.env.FLOORS || '1,2,3,4')
  .split(',')
  .map((x) => parseInt(x.trim(), 10))
  .filter((n) => Number.isFinite(n));

const MQTT_TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX || 'jatinegara';

const MQTT_HOST = process.env.MQTT_HOST || 'mqtt://gatevans.com';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';

const SCHEDULER_TICK_SECONDS = parseInt(process.env.SCHEDULER_TICK_SECONDS || '30', 10);

// Topic builder:
// jatinegara/lantai{n}/control | status | health
function topic(floor, leaf) {
  return `${MQTT_TOPIC_PREFIX}/lantai${floor}/${leaf}`;
}

// ====== POSTGRES ======
const pool = new pg.Pool({ connectionString: DATABASE_URL });

// ====== SESSION ======
app.use(session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ====== AUTH MIDDLEWARE ======
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    if (u.role !== role) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}
function requireAnyRole(roles) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    if (!roles.includes(u.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// ====== MQTT ======
const mqttClient = mqtt.connect(MQTT_HOST, {
  port: MQTT_PORT,
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
});

mqttClient.on('connect', () => {
  console.log('MQTT connected', MQTT_HOST, MQTT_PORT);
  for (const f of FLOORS) {
    mqttClient.subscribe(topic(f, 'status'));
    mqttClient.subscribe(topic(f, 'health'));
    console.log('Subscribed:', topic(f, 'status'), 'and', topic(f, 'health'));
  }
});

mqttClient.on('error', (err) => {
  console.error('MQTT error:', err.message);
});

// SSE clients
let sseClients = [];

// pending ACK match: mac|action -> command_log_id
const pendingAck = new Map();

// Helper: broadcast SSE
function sseBroadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach((res) => res.write(data));
}

// Parse inbound mqtt
mqttClient.on('message', async (t, message) => {
  const text = message.toString().trim();

  const m = t.match(new RegExp(`^${MQTT_TOPIC_PREFIX}\\/lantai(\\d+)\\/(status|health)$`));
  if (!m) return;
  const floor = parseInt(m[1], 10);
  const kind = m[2];

  try {
    if (kind === 'health') {
      // PING,84:CC:A8:...
      const parts = text.split(',');
      if (parts[0] === 'PING' && parts[1]) {
        const mac = parts[1].trim();
        const doorRes = await pool.query(`
          SELECT d.id
          FROM doors d
          JOIN chips c ON c.id = d.chip_id
          WHERE c.mac=$1
        `, [mac]);
        if (doorRes.rowCount) {
          const doorId = doorRes.rows[0].id;
          await pool.query('INSERT INTO ping_logs(door_id, ping_at) VALUES ($1, now())', [doorId]);
          sseBroadcast({ type: 'ping', floor, doorId, mac, timestamp: new Date().toISOString() });
        } else {
          sseBroadcast({ type: 'ping_unknown', floor, mac, raw: text, timestamp: new Date().toISOString() });
        }
      }
      return;
    }

    if (kind === 'status') {
      // ACK,mac,action
      const parts = text.split(',');
      if (parts[0] === 'ACK' && parts[1] && parts[2]) {
        const mac = parts[1].trim();
        const action = parts.slice(2).join(',').trim();

        const doorRes = await pool.query(`
          SELECT d.id
          FROM doors d
          JOIN chips c ON c.id = d.chip_id
          WHERE c.mac=$1
        `, [mac]);
        const doorId = doorRes.rowCount ? doorRes.rows[0].id : null;

        const key = `${mac}|${action}`;
        const cmdLogId = pendingAck.get(key);

        if (cmdLogId) {
          await pool.query(`
            UPDATE command_logs
               SET ack_at = now(),
                   latency_ms = (EXTRACT(EPOCH FROM (now() - requested_at)) * 1000)::INT
             WHERE id=$1
          `, [cmdLogId]);
          pendingAck.delete(key);
        }

        sseBroadcast({
          type: 'ack',
          floor,
          doorId,
          mac,
          action,
          raw: text,
          timestamp: new Date().toISOString()
        });
      } else {
        sseBroadcast({ type: 'status_raw', floor, raw: text, timestamp: new Date().toISOString() });
      }
    }
  } catch (e) {
    console.error('MQTT handler error:', e);
  }
});

// ====== PAGES ======
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ====== AUTH API ======
app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username/password wajib' });

  const r = await pool.query(
    'SELECT id, username, password_hash, role FROM users WHERE username=$1',
    [username]
  );
  if (!r.rowCount) return res.status(401).json({ error: 'login gagal' });

  const user = r.rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'login gagal' });

  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.json({ ok: true, role: user.role });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ====== SSE (requires login) ======
app.get('/api/events', requireLogin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  sseClients.push(res);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter((c) => c !== res);
  });
});

// ====== CHIPS API ======
app.get('/api/chips', requireRole('superadmin'), async (req, res) => {
  const r = await pool.query('SELECT id, chip_no, mac FROM chips ORDER BY chip_no');
  res.json(r.rows);
});

app.post('/api/chips', requireRole('superadmin'), async (req, res) => {
  const { chip_no, mac } = req.body || {};
  if (!chip_no || !mac) return res.status(400).json({ error: 'chip_no/mac wajib' });

  const r = await pool.query(
    'INSERT INTO chips(chip_no, mac) VALUES ($1,$2) RETURNING *',
    [chip_no, mac]
  );
  res.json(r.rows[0]);
});

app.delete('/api/chips/:id', requireRole('superadmin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await pool.query('DELETE FROM chips WHERE id=$1', [id]);
  res.json({ ok: true });
});

// ====== DOORS API ======
app.get('/api/doors', requireLogin, async (req, res) => {
  const r = await pool.query(`
    SELECT d.id, d.floor, d.room_no, d.chip_id, c.chip_no, c.mac
    FROM doors d
    LEFT JOIN chips c ON c.id = d.chip_id
    ORDER BY d.floor, d.room_no
  `);
  res.json(r.rows);
});

// superadmin can CRUD door master
app.post('/api/doors', requireRole('superadmin'), async (req, res) => {
  const { floor, room_no, chip_id } = req.body || {};
  if (!floor || !room_no) return res.status(400).json({ error: 'floor/room_no wajib' });

  const r = await pool.query(
    'INSERT INTO doors(floor, room_no, chip_id) VALUES ($1,$2,$3) RETURNING *',
    [floor, room_no, chip_id || null]
  );
  res.json(r.rows[0]);
});

app.put('/api/doors/:id', requireRole('superadmin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { floor, room_no, chip_id } = req.body || {};
  if (!floor || !room_no) return res.status(400).json({ error: 'floor/room_no wajib' });

  const r = await pool.query(
    'UPDATE doors SET floor=$1, room_no=$2, chip_id=$3, updated_at=now() WHERE id=$4 RETURNING *',
    [floor, room_no, chip_id || null, id]
  );
  res.json(r.rows[0]);
});

app.delete('/api/doors/:id', requireRole('superadmin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await pool.query('DELETE FROM doors WHERE id=$1', [id]);
  res.json({ ok: true });
});

// ====== SEND COMMAND (admin + superadmin) ======
app.post('/api/send', requireAnyRole(['admin','superadmin']), async (req, res) => {
  const { doorId, command } = req.body || {};
  if (!doorId || !command) return res.status(400).json({ error: 'doorId & command wajib' });

  const d = await pool.query(`
    SELECT d.id, d.floor, c.mac
    FROM doors d
    LEFT JOIN chips c ON c.id = d.chip_id
    WHERE d.id=$1
  `, [doorId]);
  if (!d.rowCount) return res.status(404).json({ error: 'door tidak ditemukan' });

  const door = d.rows[0];
  if (!door.mac) return res.status(400).json({ error: 'door tidak memiliki chip/MAC' });

  const msg = `${command},${door.mac}`;
  const t = topic(door.floor, 'control');

  // log command
  const log = await pool.query(
    'INSERT INTO command_logs(door_id, action) VALUES ($1,$2) RETURNING id',
    [door.id, command]
  );
  const cmdLogId = log.rows[0].id;
  pendingAck.set(`${door.mac}|${command}`, cmdLogId);

  mqttClient.publish(t, msg, { qos: 0 }, (err) => {
    if (err) return res.status(500).json({ error: 'gagal publish ke MQTT' });
    res.json({ ok: true, topic: t, message: msg, cmdLogId });
  });
});

// ====== SCHEDULE API (admin + superadmin can set schedule) ======
app.get('/api/schedules', requireAnyRole(['admin','superadmin']), async (req, res) => {
  const date = (req.query.date || '').toString(); // YYYY-MM-DD optional
  if (date) {
    const r = await pool.query(`
      SELECT s.*, d.floor, d.room_no, c.mac
        FROM schedules s
        JOIN doors d ON d.id=s.door_id
        LEFT JOIN chips c ON c.id=d.chip_id
       WHERE s.schedule_date=$1
       ORDER BY d.floor, d.room_no, s.open_time
    `, [date]);
    return res.json(r.rows);
  }
  const r = await pool.query(`
    SELECT s.*, d.floor, d.room_no, c.mac
      FROM schedules s
      JOIN doors d ON d.id=s.door_id
      LEFT JOIN chips c ON c.id=d.chip_id
     ORDER BY s.schedule_date DESC, d.floor, d.room_no, s.open_time
     LIMIT 300
  `);
  res.json(r.rows);
});

// Upsert schedule per door+date (simple: 1 schedule per door per date)
app.post('/api/schedules/upsert', requireAnyRole(['admin','superadmin']), async (req, res) => {
  const { doorId, schedule_date, open_time, close_time, enabled } = req.body || {};
  if (!doorId || !schedule_date || !open_time || !close_time) {
    return res.status(400).json({ error: 'doorId, schedule_date, open_time, close_time wajib' });
  }

  const r = await pool.query(`
    INSERT INTO schedules(door_id, schedule_date, open_time, close_time, enabled)
    VALUES ($1,$2,$3,$4,COALESCE($5,true))
    ON CONFLICT (door_id, schedule_date)
    DO UPDATE SET open_time=EXCLUDED.open_time,
                  close_time=EXCLUDED.close_time,
                  enabled=EXCLUDED.enabled,
                  open_sent_at=NULL,
                  close_sent_at=NULL,
                  updated_at=now()
    RETURNING *
  `, [doorId, schedule_date, open_time, close_time, enabled]);
  res.json(r.rows[0]);
});

// Need unique constraint for upsert:
(async () => {
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'uniq_schedule_door_date'
        ) THEN
          ALTER TABLE schedules ADD CONSTRAINT uniq_schedule_door_date UNIQUE (door_id, schedule_date);
        END IF;
      END $$;
    `);
  } catch (e) {
    console.error('ensure uniq_schedule_door_date failed:', e.message);
  }
})();

// delete schedule
app.delete('/api/schedules/:id', requireAnyRole(['admin','superadmin']), async (req, res) => {
  const id = BigInt(req.params.id);
  await pool.query('DELETE FROM schedules WHERE id=$1', [id.toString()]);
  res.json({ ok: true });
});

// ====== MONITORING (superadmin) ======

// ping count 1 day & 7 days
app.get('/api/metrics/ping-count', requireRole('superadmin'), async (req, res) => {
  const r = await pool.query(`
    SELECT d.id AS door_id, d.floor, d.room_no, c.chip_no, c.mac,
           COUNT(CASE WHEN pl.ping_at >= now() - interval '1 day' THEN 1 END) AS ping_count_1d,
           COUNT(CASE WHEN pl.ping_at >= now() - interval '7 days' THEN 1 END) AS ping_count_7d
      FROM doors d
      LEFT JOIN chips c ON c.id = d.chip_id
      LEFT JOIN ping_logs pl ON pl.door_id=d.id
     GROUP BY d.id, c.chip_no, c.mac
     ORDER BY d.floor, d.room_no
  `);
  res.json(r.rows);
});

// health from last ping (12 jam interval dengan toleransi 4 menit)
app.get('/api/health', requireRole('superadmin'), async (req, res) => {
  const r = await pool.query(`
    SELECT d.id AS door_id, d.floor, d.room_no, c.mac,
           MAX(pl.ping_at) AS last_ping_at
      FROM doors d
      LEFT JOIN chips c ON c.id = d.chip_id
      LEFT JOIN ping_logs pl ON pl.door_id=d.id
     GROUP BY d.id, c.mac
     ORDER BY d.floor, d.room_no
  `);

  const now = Date.now();
  const rows = r.rows.map((x) => {
    const last = x.last_ping_at ? new Date(x.last_ping_at).getTime() : null;
    const ageMin = last ? (now - last) / 60000 : null;
    // PING expected 12 jam (720 min). Consider unhealthy if > 12 jam + 4 min = 724 min.
    return { ...x, ping_age_min: ageMin, healthy: last ? ageMin <= 724 : false };
  });

  res.json(rows);
});

// downtime today (minutes) estimate based on ping gaps (12 jam interval + 4 min toleransi = 724 min)
app.get('/api/metrics/downtime-today', requireRole('superadmin'), async (req, res) => {
  const r = await pool.query(`
    SELECT d.id AS door_id, d.floor, d.room_no, c.mac, pl.ping_at
      FROM doors d
      LEFT JOIN chips c ON c.id = d.chip_id
      LEFT JOIN ping_logs pl
        ON pl.door_id=d.id
       AND pl.ping_at >= date_trunc('day', now())
     ORDER BY d.id, pl.ping_at
  `);

  const byDoor = new Map();
  for (const row of r.rows) {
    if (!byDoor.has(row.door_id)) byDoor.set(row.door_id, { door: row, times: [] });
    if (row.ping_at) byDoor.get(row.door_id).times.push(new Date(row.ping_at).getTime());
  }

  const out = [];
  for (const [doorId, v] of byDoor.entries()) {
    const times = v.times;
    let downtimeMin = 0;

    for (let i = 1; i < times.length; i++) {
      const gapMin = (times[i] - times[i - 1]) / 60000;
      if (gapMin > 724) downtimeMin += Math.max(0, gapMin - 720);
    }

    out.push({
      door_id: doorId,
      floor: v.door.floor,
      room_no: v.door.room_no,
      mac: v.door.mac,
      downtime_min_today: Math.round(downtimeMin)
    });
  }

  out.sort((a, b) => (a.floor - b.floor) || a.room_no.localeCompare(b.room_no));
  res.json(out);
});

// ====== SCHEDULER (runs in server) ======
async function schedulerTick() {
  // Interpret schedule in WIB (TZ)
  const now = DateTime.now().setZone(TZ);
  const today = now.toISODate(); // YYYY-MM-DD
  const hhmm = now.toFormat('HH:mm');

  try {
    // load schedules today enabled
    const r = await pool.query(`
      SELECT s.id, s.door_id, s.schedule_date, s.open_time::text AS open_time,
             s.close_time::text AS close_time, s.open_sent_at, s.close_sent_at,
             d.floor, c.mac
        FROM schedules s
        JOIN doors d ON d.id=s.door_id
        LEFT JOIN chips c ON c.id=d.chip_id
       WHERE s.enabled=true
         AND s.schedule_date=$1
    `, [today]);

    for (const s of r.rows) {
      const openHHMM = (s.open_time || '').slice(0,5);
      const closeHHMM = (s.close_time || '').slice(0,5);

      // send buka
      if (!s.open_sent_at && hhmm >= openHHMM && hhmm < closeHHMM) {
        const msg = `buka,${s.mac}`;
        mqttClient.publish(topic(s.floor, 'control'), msg, { qos: 0 });

        // log + mark sent
        const log = await pool.query(
          'INSERT INTO command_logs(door_id, action) VALUES ($1,$2) RETURNING id',
          [s.door_id, 'buka']
        );
        pendingAck.set(`${s.mac}|buka`, log.rows[0].id);

        await pool.query('UPDATE schedules SET open_sent_at=now(), updated_at=now() WHERE id=$1', [s.id]);

        sseBroadcast({ type: 'schedule_fired', scheduleId: s.id, doorId: s.door_id, action: 'buka', at: now.toISO() });
      }

      // send kunci (after close_time)
      if (!s.close_sent_at && hhmm >= closeHHMM) {
        const msg = `kunci,${s.mac}`;
        mqttClient.publish(topic(s.floor, 'control'), msg, { qos: 0 });

        const log = await pool.query(
          'INSERT INTO command_logs(door_id, action) VALUES ($1,$2) RETURNING id',
          [s.door_id, 'kunci']
        );
        pendingAck.set(`${s.mac}|kunci`, log.rows[0].id);

        await pool.query('UPDATE schedules SET close_sent_at=now(), updated_at=now() WHERE id=$1', [s.id]);

        sseBroadcast({ type: 'schedule_fired', scheduleId: s.id, doorId: s.door_id, action: 'kunci', at: now.toISO() });
      }
    }
  } catch (e) {
    console.error('schedulerTick error:', e.message);
  }
}

setInterval(schedulerTick, Math.max(5, SCHEDULER_TICK_SECONDS) * 1000);

// ====== START ======
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ISK Doorlock web running at http://0.0.0.0:${PORT}`);
  console.log('TZ:', TZ, 'Floors:', FLOORS.join(','));
});
