import express from 'express';
import session from 'express-session';
import passport from 'passport';
import connectPgSimple from 'connect-pg-simple';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import pg from 'pg';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;
const PgSession = connectPgSimple(session);
const PORT = process.env.PORT || 5000;
const DATA_FILE = join(__dirname, 'shortcut-data.json');

// ---- DATABASE ----
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR PRIMARY KEY,
      email VARCHAR UNIQUE,
      first_name VARCHAR,
      last_name VARCHAR,
      is_paid BOOLEAN DEFAULT TRUE,
      is_owner BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_data (
      user_id VARCHAR NOT NULL,
      key VARCHAR NOT NULL,
      value JSONB,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS shortcut_readings (
      user_id VARCHAR NOT NULL,
      date VARCHAR NOT NULL,
      hrv FLOAT,
      hr FLOAT,
      sleep FLOAT,
      timestamp TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, date)
    );

    CREATE TABLE IF NOT EXISTS shortcut_readings_history (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR NOT NULL,
      date VARCHAR NOT NULL,
      metric VARCHAR NOT NULL,
      value FLOAT,
      timestamp TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('Database ready');
}

// ---- LEGACY FILE BACKUP ----
function loadShortcutData() {
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveShortcutData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ---- APP ----
const app = express();
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', 1);

// ---- SESSION ----
app.use(session({
  store: new PgSession({ pool, tableName: 'sessions' }),
  secret: process.env.SESSION_SECRET || 'giorno-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: !!process.env.NODE_ENV, sameSite: 'lax', maxAge: 7*24*60*60*1000 }
}));

app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Unauthorized' });
}

// ---- LOGIN ----
app.get('/api/login', async (req, res) => {
  const testUser = {
    id: 'test-user-1',
    email: 'stephaniebarchiesi@gmail.com',
    first_name: 'Stephanie',
    last_name: 'Barchiesi',
    is_paid: true,
    is_owner: true
  };

  await pool.query(`
    INSERT INTO users (id, email, first_name, last_name, is_paid, is_owner)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO NOTHING
  `, [testUser.id, testUser.email, testUser.first_name, testUser.last_name, true, true]);

  req.logIn(testUser, err => {
    if (err) return res.status(500).json({ message: 'Login failed' });
    res.json({ ok: true, user: testUser });
  });
});

// ---- USER DATA API ----
app.get('/api/data', isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM user_data WHERE user_id=$1', [req.user.id]);
    const data = {};
    result.rows.forEach(r => data[r.key] = r.value);
    res.json(data);
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/data', isAuthenticated, async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(`
        INSERT INTO user_data (user_id, key, value, updated_at)
        VALUES ($1,$2,$3,NOW())
        ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
      `, [req.user.id, key, JSON.stringify(value)]);
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// ---- SHORTCUT / DAILY LOG ----
app.get('/shortcut', isAuthenticated, async (req, res) => {
  const { sleep, hr, hrv } = req.query;
  const userId = req.user.id;
  const today = new Date().toISOString().split('T')[0];

  try {
    // Get existing row
    const existing = await pool.query('SELECT * FROM shortcut_readings WHERE user_id=$1 AND date=$2', [userId, today]);
    const row = existing.rows[0] || {};

    // Prepare update values
    const updates = {};
    if (sleep) updates.sleep = parseFloat(sleep);
    if (hr) updates.hr = parseFloat(hr);
    if (hrv) updates.hrv = parseFloat(hrv);

    // Insert or update main table
    await pool.query(`
      INSERT INTO shortcut_readings (user_id, date, sleep, hr, hrv, timestamp)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (user_id,date) DO UPDATE SET
        sleep=COALESCE(EXCLUDED.sleep, shortcut_readings.sleep),
        hr=COALESCE(EXCLUDED.hr, shortcut_readings.hr),
        hrv=COALESCE(EXCLUDED.hrv, shortcut_readings.hrv),
        timestamp=NOW()
    `, [userId, today, updates.sleep ?? row.sleep, updates.hr ?? row.hr, updates.hrv ?? row.hrv]);

    // Insert into history table
    for (const [metric, value] of Object.entries(updates)) {
      await pool.query(`
        INSERT INTO shortcut_readings_history (user_id, date, metric, value)
        VALUES ($1,$2,$3,$4)
      `, [userId, today, metric, value]);
    }

    res.json({ ok: true, today: updates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error saving shortcut data' });
  }
});

// ---- HISTORY ----
app.get('/shortcut-history', isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shortcut_readings_history WHERE user_id=$1 ORDER BY date DESC, timestamp DESC LIMIT 100', [req.user.id]);
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ message: 'Error fetching history' }); }
});

// ---- DAILY LOG DATA ----
app.get('/shortcut-data', isAuthenticated, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const result = await pool.query('SELECT * FROM shortcut_readings WHERE user_id=$1 AND date=$2', [req.user.id, today]);
    if (result.rows.length) return res.json(result.rows[0]);
  } catch (err) { console.error(err); }
  // fallback to legacy file
  const data = loadShortcutData();
  res.json(data[today] || {});
});

// ---- STATIC / FRONTEND ----
app.get('/', (req, res) => {
  const filePath = join(__dirname, 'giorno.html');
  try {
    let html = readFileSync(filePath, 'utf8');

    if (req.isAuthenticated()) {
      const injection = `<script>
window.__GIORNO_USER__ = ${JSON.stringify(req.user)};
</script>`;
      const headClose = html.indexOf('</head>');
      if (headClose !== -1) html = html.slice(0, headClose) + injection + '\n</head>' + html.slice(headClose + 7);
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch {
    res.status(404).send('giorno.html not found');
  }
});

// ---- START ----
initDb().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
