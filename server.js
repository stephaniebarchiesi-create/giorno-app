import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
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
    CREATE TABLE IF NOT EXISTS sessions (
      sid VARCHAR PRIMARY KEY,
      sess JSONB NOT NULL,
      expire TIMESTAMP NOT NULL
    );
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON sessions (expire);

    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR PRIMARY KEY,
      email VARCHAR UNIQUE,
      first_name VARCHAR,
      last_name VARCHAR,
      profile_image_url VARCHAR,
      is_paid BOOLEAN DEFAULT FALSE,
      is_owner BOOLEAN DEFAULT FALSE,
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

    CREATE TABLE IF NOT EXISTS shortcut_tokens (
      user_id VARCHAR PRIMARY KEY,
      token VARCHAR UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS shortcut_readings (
      user_id VARCHAR NOT NULL,
      date VARCHAR NOT NULL,
      hrv FLOAT,
      hr FLOAT,
      sleep FLOAT,
      notes TEXT,
      timestamp TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, date)
    );
  `);
  console.log('Database tables ready');
}

// ---- SHORTCUT FILE FALLBACK ----
function loadShortcutData() {
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveShortcutData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ---- SLEEP PARSING ----
function parseSleep(raw) {
  if (!raw) return null;
  const s = String(raw);
  let val;
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.length === 2) val = parts[0] <= 24 ? parts[0] + parts[1]/60 : (parts[0]*60+parts[1])/3600;
  } else {
    val = parseFloat(s);
    if (val > 1440) val = val/3600;
    else if (val > 24) val = val/60;
  }
  return val != null ? parseFloat(val.toFixed(2)) : null;
}

// ---- EXPRESS APP ----
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

// ---- SESSION ----
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: false, tableName: 'sessions' }),
  secret: process.env.SESSION_SECRET || 'giorno-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: !!process.env.NODE_ENV, sameSite: 'lax', maxAge: 7*24*60*60*1000 }
}));

// ---- AUTH STUB ----
function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ message: 'Unauthorized' });
}
app.post('/api/login', (req, res) => {
  const { id, email, firstName, lastName } = req.body;
  req.session.user = { id, email, firstName, lastName };
  res.json({ ok: true });
});

// ---- USER DATA API ----
app.get('/api/data', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await pool.query('SELECT key, value FROM user_data WHERE user_id=$1', [userId]);
    const data = {};
    result.rows.forEach(r => data[r.key] = r.value);
    res.json(data);
  } catch (err) { console.error(err); res.status(500).json({ message:'Server error' }); }
});

app.post('/api/data', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(`
        INSERT INTO user_data (user_id,key,value,updated_at)
        VALUES($1,$2,$3,NOW())
        ON CONFLICT(user_id,key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
      `, [userId, key, JSON.stringify(value)]);
    }
    res.json({ ok: true });
  } catch(err){ console.error(err); res.status(500).json({ message:'Server error' }); }
});

// ---- SHORTCUT ENDPOINT ----
app.get('/shortcut', async (req, res) => {
  const { hrv, hr, sleep } = req.query;
  const today = new Date().toISOString().split('T')[0];
  const sleepVal = parseSleep(sleep);

  // Fallback file-based storage
  const data = loadShortcutData();
  const existing = data[today] || {};
  data[today] = {
    hrv: hrv ? parseFloat(hrv) : existing.hrv ?? null,
    hr: hr ? parseFloat(hr) : existing.hr ?? null,
    sleep: sleepVal ?? existing.sleep ?? null,
    timestamp: new Date().toISOString()
  };
  saveShortcutData(data);
  res.json({ ok: true, saved: data[today] });
});

// ---- SHORTCUT HISTORY ----
app.get('/shortcut-history', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await pool.query(
      'SELECT * FROM shortcut_readings WHERE user_id=$1 ORDER BY date DESC LIMIT 30',
      [userId]
    );
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ message:'Server error' }); }
});

app.post('/shortcut-history/:date', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { date } = req.params;
    const updates = req.body;

    const existing = await pool.query(
      'SELECT * FROM shortcut_readings WHERE user_id=$1 AND date=$2',
      [userId, date]
    );
    const ex = existing.rows[0] || {};

    const merged = {
      sleep: updates.sleep ?? ex.sleep ?? null,
      hr: updates.hr ?? ex.hr ?? null,
      hrv: updates.hrv ?? ex.hrv ?? null,
      notes: updates.notes ?? ex.notes ?? null,
      timestamp: new Date().toISOString()
    };

    await pool.query(`
      INSERT INTO shortcut_readings (user_id,date,hrv,hr,sleep,notes,timestamp)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(user_id,date) DO UPDATE SET
        hrv=COALESCE(EXCLUDED.hrv,shortcut_readings.hrv),
        hr=COALESCE(EXCLUDED.hr,shortcut_readings.hr),
        sleep=COALESCE(EXCLUDED.sleep,shortcut_readings.sleep),
        notes=COALESCE(EXCLUDED.notes,shortcut_readings.notes),
        timestamp=EXCLUDED.timestamp
    `, [userId,date,merged.hrv,merged.hr,merged.sleep,merged.notes,merged.timestamp]);

    res.json({ ok:true, saved: merged });
  } catch(err){ console.error(err); res.status(500).json({ message:'Server error' }); }
});

// ---- SERVE STATIC ----
app.get('/', (req,res)=>{
  try {
    const html = readFileSync(join(__dirname,'giorno.html'),'utf8');
    res.setHeader('Content-Type','text/html');
    res.send(html);
  } catch { res.status(404).send('giorno.html not found'); }
});

// ---- START SERVER ----
initDb().then(()=>{
  app.listen(PORT,()=>console.log(`Giorno server running on port ${PORT}`));
}).catch(err=>{
  console.error('DB init failed:', err);
  process.exit(1);
});
