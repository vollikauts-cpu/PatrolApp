import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

mkdirSync('data', { recursive: true });

const db = new DatabaseSync('data/patrolapp.sqlite');
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    })
);

const SECRET = env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error('JWT_SECRET отсутствует или слишком короткий');
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 email TEXT UNIQUE,
 role TEXT NOT NULL DEFAULT 'guard'
);

CREATE TABLE IF NOT EXISTS sites (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 address TEXT
);

CREATE TABLE IF NOT EXISTS shifts (
 id INTEGER PRIMARY KEY,
 user_id INTEGER,
 site_id INTEGER,
 starts_at TEXT,
 ends_at TEXT,
 status TEXT DEFAULT 'scheduled'
);

CREATE TABLE IF NOT EXISTS patrols (
 id INTEGER PRIMARY KEY,
 user_id INTEGER,
 site_id INTEGER,
 started_at TEXT,
 ended_at TEXT,
 status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS incidents (
 id INTEGER PRIMARY KEY,
 site_id INTEGER,
 title TEXT NOT NULL,
 description TEXT,
 status TEXT DEFAULT 'open',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_accounts (
 user_id INTEGER PRIMARY KEY REFERENCES users(id),
 password_hash TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS calls (
 id INTEGER PRIMARY KEY,
 type TEXT NOT NULL CHECK(type IN ('dispatch','alarm')),
 site_id INTEGER REFERENCES sites(id),
 guard_id INTEGER REFERENCES users(id),
 dispatcher_id INTEGER REFERENCES users(id),
 created_by INTEGER NOT NULL REFERENCES users(id),
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 priority TEXT NOT NULL DEFAULT 'normal',
 status TEXT NOT NULL DEFAULT 'new',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS call_events (
 id INTEGER PRIMARY KEY,
 call_id INTEGER NOT NULL REFERENCES calls(id),
 actor_id INTEGER NOT NULL REFERENCES users(id),
 action TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ]
}));

const roles = ['admin', 'dispatcher', 'guard'];

const fail = (res, status, message) =>
  res.status(status).json({ error: message });

function auth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!token) return fail(res, 401, 'Требуется вход');

  try {
    const payload = jwt.verify(token, SECRET, {
      algorithms: ['HS256']
    });

    const user = db.prepare(`
      SELECT u.id, u.name, u.email, u.role
      FROM users u
      JOIN auth_accounts a ON a.user_id=u.id
      WHERE u.id=? AND a.active=1
    `).get(payload.sub);

    if (!user) return fail(res, 401, 'Пользователь недоступен');
    req.user = user;
    next();
  } catch {
    return fail(res, 401, 'Недействительный токен');
  }
}

function allow(...allowed) {
  return (req, res, next) =>
    allowed.includes(req.user.role)
      ? next()
      : fail(res, 403, 'Недостаточно прав');
}

const clean = (value, max = 200) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const validEmail = email =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function logEvent(callId, actorId, action) {
  db.prepare(`
    INSERT INTO call_events(call_id,actor_id,action)
    VALUES(?,?,?)
  `).run(callId, actorId, action);
}

// Создание первого администратора
const accountCount = db.prepare(
  'SELECT COUNT(*) AS n FROM auth_accounts'
).get().n;

if (accountCount === 0) {
  const password = randomBytes(15).toString('base64url');
  const email = 'admin@patrolapp.local';

  const existing = db.prepare(
    'SELECT id FROM users WHERE email=?'
  ).get(email);

  const userId = existing?.id ?? Number(
    db.prepare(`
      INSERT INTO users(name,email,role)
      VALUES('Administrator',?,'admin')
    `).run(email).lastInsertRowid
  );

  db.prepare(
    "UPDATE users SET role='admin' WHERE id=?"
  ).run(userId);

  db.prepare(`
    INSERT INTO auth_accounts(user_id,password_hash)
    VALUES(?,?)
  `).run(userId, bcrypt.hashSync(password, 12));

  console.log('\n=== ПЕРВЫЙ АДМИНИСТРАТОР ===');
  console.log('Email:', email);
  console.log('Пароль:', password);
  console.log('СОХРАНИ ПАРОЛЬ! Он показывается один раз.\n');
}

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, service: 'PatrolApp API' })
);

app.post('/api/auth/login', (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const password = req.body.password;

  if (!validEmail(email) || typeof password !== 'string') {
    return fail(res, 400, 'Неверные данные');
  }

  const account = db.prepare(`
    SELECT u.id,u.name,u.email,u.role,
           a.password_hash,a.active
    FROM users u
    JOIN auth_accounts a ON a.user_id=u.id
    WHERE lower(u.email)=?
  `).get(email);

  if (!account || !account.active ||
      !bcrypt.compareSync(password, account.password_hash)) {
    return fail(res, 401, 'Неверный email или пароль');
  }

  const token = jwt.sign(
    { sub: String(account.id) },
    SECRET,
    { algorithm: 'HS256', expiresIn: '8h' }
  );

  res.json({
    token,
    user: {
      id: account.id,
      name: account.name,
      email: account.email,
      role: account.role
    }
  });
});

app.get('/api/auth/me', auth, (req, res) =>
  res.json(req.user)
);

app.get('/api/summary', auth, (req, res) => {
  const count = table =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  res.json({
    users: count('users'),
    sites: count('sites'),
    shifts: count('shifts'),
    patrols: count('patrols'),
    incidents: count('incidents'),
    calls: count('calls')
  });
});

app.get('/api/users', auth, allow('admin','dispatcher'), (req, res) => {
  res.json(db.prepare(`
    SELECT id,name,email,role FROM users ORDER BY id DESC
  `).all());
});

app.post('/api/users', auth, allow('admin'), (req, res) => {
  const name = clean(req.body.name, 120);
  const email = clean(req.body.email, 200).toLowerCase();
  const role = req.body.role;
  const password = req.body.password;

  if (!name || !validEmail(email) ||
      !roles.includes(role) ||
      typeof password !== 'string' ||
      password.length < 12) {
    return fail(res, 400, 'Проверь имя, email, роль и пароль (от 12 символов)');
  }

  try {
    const result = db.prepare(`
      INSERT INTO users(name,email,role) VALUES(?,?,?)
    `).run(name, email, role);

    const id = Number(result.lastInsertRowid);

    db.prepare(`
      INSERT INTO auth_accounts(user_id,password_hash)
      VALUES(?,?)
    `).run(id, bcrypt.hashSync(password, 12));

    res.status(201).json({ id });
  } catch {
    return fail(res, 409, 'Email уже существует или ошибка сохранения');
  }
});

app.get('/api/sites', auth, (req, res) => {
  res.json(db.prepare(
    'SELECT id,name,address,latitude,longitude FROM sites ORDER BY id DESC'
  ).all());
});

app.post('/api/sites', auth, allow('admin'), (req, res) => {
  const name = clean(req.body.name, 120);
  const address = clean(req.body.address, 200);

  if (!name) return fail(res, 400, 'Укажите название');

  const result = db.prepare(
    'INSERT INTO sites(name,address) VALUES(?,?)'
  ).run(name, address);

  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.get('/api/incidents', auth, allow('admin','dispatcher'), (req, res) => {
  res.json(db.prepare(
    'SELECT * FROM incidents ORDER BY id DESC LIMIT 100'
  ).all());
});

app.get('/api/calls', auth, (req, res) => {
  const where = req.user.role === 'guard'
    ? 'WHERE c.guard_id=? OR c.created_by=?'
    : '';

  const args = req.user.role === 'guard'
    ? [req.user.id, req.user.id]
    : [];

  res.json(db.prepare(`
    SELECT c.*, s.name AS site_name,
           g.name AS guard_name,
           d.name AS dispatcher_name
    FROM calls c
    LEFT JOIN sites s ON s.id=c.site_id
    LEFT JOIN users g ON g.id=c.guard_id
    LEFT JOIN users d ON d.id=c.dispatcher_id
    ${where}
    ORDER BY c.id DESC LIMIT 200
  `).all(...args));
});

app.post('/api/calls', auth, (req, res) => {
  const type = req.body.type;
  const title = clean(req.body.title, 150);
  const description = clean(req.body.description, 2000);
  const priority = req.body.priority === 'urgent'
    ? 'urgent' : 'normal';

  if (!title || !['dispatch','alarm'].includes(type)) {
    return fail(res, 400, 'Укажите тип и название вызова');
  }

  if (type === 'dispatch' &&
      !['admin','dispatcher'].includes(req.user.role)) {
    return fail(res, 403, 'Отправлять задания может только диспетчер');
  }

  if (type === 'alarm' && req.user.role !== 'guard') {
    return fail(res, 403, 'Тревога доступна охраннику');
  }

  const guardId = type === 'alarm'
    ? req.user.id : Number(req.body.guard_id);

  const guard = db.prepare(
    "SELECT id FROM users WHERE id=? AND role='guard'"
  ).get(guardId);

  if (!guard) return fail(res, 400, 'Охранник не найден');

  const siteId = req.body.site_id == null ||
    req.body.site_id === '' ? null : Number(req.body.site_id);

  if (siteId !== null && !db.prepare(
    'SELECT id FROM sites WHERE id=?'
  ).get(siteId)) {
    return fail(res, 400, 'Объект не найден');
  }

  const result = db.prepare(`
    INSERT INTO calls(
      type,site_id,guard_id,dispatcher_id,
      created_by,title,description,priority,status
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `).run(
    type,
    siteId,
    guardId,
    type === 'dispatch' ? req.user.id : null,
    req.user.id,
    title,
    description,
    priority,
    type === 'alarm' ? 'alarm' : 'new'
  );

  const id = Number(result.lastInsertRowid);
  logEvent(id, req.user.id, 'created');

  res.status(201).json({ id });
});

app.patch('/api/calls/:id/status', auth, (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status;

  const call = db.prepare(
    'SELECT * FROM calls WHERE id=?'
  ).get(id);

  if (!call) return fail(res, 404, 'Вызов не найден');

  const transitions = {
    new: ['accepted'],
    accepted: ['enroute'],
    enroute: [],
    onsite: [],
    alarm: ['acknowledged'],
    acknowledged: ['completed'],
    completed: []
  };

  if (!transitions[call.status]?.includes(status)) {
    return fail(res, 400, 'Недопустимый переход статуса');
  }

  const isGuard = req.user.role === 'guard';
  const isDispatcher = ['admin','dispatcher'].includes(req.user.role);

  if (call.type === 'dispatch') {
    if (!isGuard || call.guard_id !== req.user.id) {
      return fail(res, 403, 'Это задание другого охранника');
    }
  } else {
    if (!isDispatcher) {
      return fail(res, 403, 'Тревогу обрабатывает диспетчер');
    }
  }

  db.prepare(`
    UPDATE calls
    SET status=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(status, id);

  logEvent(id, req.user.id, status);
  res.json({ ok: true, status });
});

app.get('/api/calls/:id/events', auth, (req, res) => {
  const id = Number(req.params.id);
  const call = db.prepare(
    'SELECT guard_id,created_by FROM calls WHERE id=?'
  ).get(id);

  if (!call) return fail(res, 404, 'Вызов не найден');

  if (req.user.role === 'guard' &&
      call.guard_id !== req.user.id &&
      call.created_by !== req.user.id) {
    return fail(res, 403, 'Нет доступа');
  }

  res.json(db.prepare(`
    SELECT e.*,u.name AS actor_name
    FROM call_events e
    JOIN users u ON u.id=e.actor_id
    WHERE e.call_id=?
    ORDER BY e.id ASC
  `).all(id));
});


// PATROLAPP_REPORTS_V1

db.exec(`
CREATE TABLE IF NOT EXISTS call_reports (
 id INTEGER PRIMARY KEY,
 call_id INTEGER NOT NULL UNIQUE REFERENCES calls(id),
 guard_id INTEGER NOT NULL REFERENCES users(id),
 report TEXT NOT NULL,
 arrived_at TEXT,
 completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS call_arrivals (
 call_id INTEGER PRIMARY KEY REFERENCES calls(id),
 guard_id INTEGER NOT NULL REFERENCES users(id),
 arrived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

app.get('/api/calls/:id/report', auth, (req, res) => {
  const id = Number(req.params.id);

  const call = db.prepare(
    'SELECT * FROM calls WHERE id=?'
  ).get(id);

  if (!call) return fail(res, 404, 'Вызов не найден');

  if (req.user.role === 'guard' &&
      call.guard_id !== req.user.id) {
    return fail(res, 403, 'Нет доступа');
  }

  const report = db.prepare(
    'SELECT * FROM call_reports WHERE call_id=?'
  ).get(id);

  res.json(report || null);
});

app.post('/api/calls/:id/arrive', auth, allow('guard'), (req, res) => {
  const id = Number(req.params.id);

  const call = db.prepare(
    'SELECT * FROM calls WHERE id=?'
  ).get(id);

  if (!call) return fail(res, 404, 'Вызов не найден');

  if (call.guard_id !== req.user.id) {
    return fail(res, 403, 'Это задание другого охранника');
  }

  if (call.type !== 'dispatch' ||
      !['accepted', 'enroute'].includes(call.status)) {
    return fail(res, 409, 'Сначала необходимо принять вызов');
  }

  const transaction = db.transaction?.bind(db);

  const save = () => {
    db.prepare(`
      INSERT OR IGNORE INTO call_arrivals(call_id,guard_id)
      VALUES(?,?)
    `).run(id, req.user.id);

    db.prepare(`
      UPDATE calls
      SET status='onsite',updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(id);

    logEvent(id, req.user.id, 'onsite');
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    save();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    return fail(res, 500, 'Не удалось сохранить прибытие');
  }

  res.json({ ok: true, status: 'onsite' });
});

app.post('/api/calls/:id/complete', auth, allow('guard'), (req, res) => {
  const id = Number(req.params.id);
  const report = clean(req.body.report, 5000);

  if (report.length < 20) {
    return fail(res, 400, 'Рапорт должен содержать минимум 20 символов');
  }

  const call = db.prepare(
    'SELECT * FROM calls WHERE id=?'
  ).get(id);

  if (!call) return fail(res, 404, 'Вызов не найден');

  if (call.guard_id !== req.user.id) {
    return fail(res, 403, 'Это задание другого охранника');
  }

  if (call.type !== 'dispatch' || call.status !== 'onsite') {
    return fail(res, 409, 'Сначала отметьте прибытие на объект');
  }

  const arrival = db.prepare(
    'SELECT * FROM call_arrivals WHERE call_id=?'
  ).get(id);

  if (!arrival) {
    return fail(res, 409, 'Время прибытия не зарегистрировано');
  }

  db.exec('BEGIN IMMEDIATE');

  try {
    db.prepare(`
      INSERT INTO call_reports(call_id,guard_id,report,arrived_at)
      VALUES(?,?,?,?)
    `).run(id, req.user.id, report, arrival.arrived_at);

    db.prepare(`
      UPDATE calls
      SET status='completed',updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(id);

    logEvent(id, req.user.id, 'completed_with_report');

    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
    return fail(res, 409, 'Не удалось завершить вызов');
  }

  res.json({ ok: true, status: 'completed' });
});


// PATROLAPP_MAP_V2
// Координаты объектов и добровольная геолокация патрулей.

const siteColumns = db.prepare("PRAGMA table_info(sites)").all()
  .map(column => column.name);

if (!siteColumns.includes('latitude')) {
  db.exec('ALTER TABLE sites ADD COLUMN latitude REAL');
}
if (!siteColumns.includes('longitude')) {
  db.exec('ALTER TABLE sites ADD COLUMN longitude REAL');
}

db.exec(`
CREATE TABLE IF NOT EXISTS patrol_locations (
 user_id INTEGER PRIMARY KEY REFERENCES users(id),
 latitude REAL NOT NULL,
 longitude REAL NOT NULL,
 status TEXT NOT NULL DEFAULT 'available',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const validCoordinates = (lat, lon) =>
  typeof lat === 'number' &&
  typeof lon === 'number' &&
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  lat >= -90 && lat <= 90 &&
  lon >= -180 && lon <= 180;

app.patch('/api/sites/:id/location',
  auth, allow('admin'), (req, res) => {
    const id = Number(req.params.id);
    const { latitude, longitude } = req.body;

    if (!validCoordinates(latitude, longitude)) {
      return fail(res, 400, 'Неверные координаты');
    }

    const result = db.prepare(`
      UPDATE sites SET latitude=?, longitude=? WHERE id=?
    `).run(latitude, longitude, id);

    if (!result.changes) {
      return fail(res, 404, 'Объект не найден');
    }

    res.json({ ok: true });
  }
);

app.post('/api/patrol/location', auth, allow('guard'),
  (req, res) => {
    const { latitude, longitude } = req.body;

    if (!validCoordinates(latitude, longitude)) {
      return fail(res, 400, 'Неверные координаты');
    }

    db.prepare(`
      INSERT INTO patrol_locations
        (user_id,latitude,longitude,status,updated_at)
      VALUES(?,?, 'available', 'available', CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        latitude=excluded.latitude,
        longitude=excluded.longitude,
        updated_at=CURRENT_TIMESTAMP
    `);
    // Запись ниже использует корректный набор параметров.
    db.prepare(`
      INSERT INTO patrol_locations
        (user_id,latitude,longitude,status,updated_at)
      VALUES(?,?,?,'available',CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        latitude=excluded.latitude,
        longitude=excluded.longitude,
        updated_at=CURRENT_TIMESTAMP
    `).run(req.user.id, latitude, longitude);

    res.json({ ok: true });
  }
);

app.delete('/api/patrol/location', auth, allow('guard'),
  (req, res) => {
    db.prepare('DELETE FROM patrol_locations WHERE user_id=?')
      .run(req.user.id);
    res.json({ ok: true });
  }
);

app.get('/api/map', auth, (req, res) => {
  const sites = db.prepare(`
    SELECT id,name,address,latitude,longitude
    FROM sites
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  `).all();

  const calls = req.user.role === 'guard'
    ? db.prepare(`
        SELECT id,site_id,title,status,priority,type
        FROM calls
        WHERE guard_id=? AND status!='completed'
      `).all(req.user.id)
    : db.prepare(`
        SELECT id,site_id,title,status,priority,type
        FROM calls
        WHERE status!='completed'
      `).all();

  const patrols = req.user.role === 'guard'
    ? db.prepare(`
        SELECT p.user_id,p.latitude,p.longitude,p.status,
               p.updated_at,u.name
        FROM patrol_locations p
        JOIN users u ON u.id=p.user_id
        WHERE p.user_id=?
          AND p.updated_at>=datetime('now','-2 minutes')
      `).all(req.user.id)
    : db.prepare(`
        SELECT p.user_id,p.latitude,p.longitude,p.status,
               p.updated_at,u.name
        FROM patrol_locations p
        JOIN users u ON u.id=p.user_id
        WHERE p.updated_at>=datetime('now','-2 minutes')
      `).all();

  res.json({ sites,calls,patrols });
});

app.listen(3001, '127.0.0.1', () => {
  console.log('PatrolApp Secure API: http://127.0.0.1:3001');
});
