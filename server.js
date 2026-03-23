import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5000;
const DATA_FILE = path.join(__dirname, 'shortcut-data.json');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PgSession = connectPgSimple(session);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', 1);

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'giorno-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: !!process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7*24*60*60*1000 }
}));

// ---- DB INIT ----
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR PRIMARY KEY,
      email VARCHAR UNIQUE,
      first_name VARCHAR,
      last_name VARCHAR,
      is_paid BOOLEAN DEFAULT FALSE,
      is_owner BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS shortcut_tokens (
      user_id VARCHAR PRIMARY KEY,
      token VARCHAR UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS shortcut_readings (
      user_id VARCHAR NOT NULL,
      date VARCHAR NOT NULL,
      data JSONB,
      timestamp TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, date)
    );
  `);
  console.log('Database tables ready');
}

// ---- LEGACY FILE STORAGE ----
function loadShortcutData() {
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveShortcutData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ---- AUTH ----
app.use((req, res, next) => {
  req.isAuthenticated = () => !!req.session.user;
  next();
});
app.get('/api/login', async (req, res) => {
  const user = {
    id: 'test-user-1',
    email: 'stephaniebarchiesi@gmail.com',
    first_name: 'Stephanie',
    last_name: 'Barchiesi',
    is_owner: true,
    is_paid: true
  };
  await pool.query(`
    INSERT INTO users (id, email, first_name, last_name, is_owner, is_paid)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO UPDATE
      SET is_owner = EXCLUDED.is_owner,
          is_paid = EXCLUDED.is_paid,
          updated_at = NOW()
  `, [user.id, user.email, user.first_name, user.last_name, user.is_owner, user.is_paid]);

  req.session.user = user;
  res.json({ ok: true, user });
});

function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Unauthorized' });
}

// ---- SHORTCUT TOKEN ENDPOINT ----
app.post('/shortcut-token', isAuthenticated, async (req, res) => {
  try {
    const token = 'sc_' + crypto.randomBytes(16).toString('hex');
    await pool.query(`
      INSERT INTO shortcut_tokens (user_id, token)
      VALUES ($1,$2)
      ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token
    `, [req.session.user.id, token]);
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---- SHORTCUT DATA ENDPOINT ----
app.get('/shortcut', async (req, res) => {
  const { token, ...incoming } = req.query;
  const today = new Date().toISOString().split('T')[0];

  if (!token) return res.status(400).json({ message: 'No token provided' });

  try {
    const result = await pool.query('SELECT user_id FROM shortcut_tokens WHERE token=$1', [token]);
    if (!result.rows.length) return res.status(401).json({ message: 'Invalid token' });
    const userId = result.rows[0].user_id;

    const existing = await pool.query('SELECT data FROM shortcut_readings WHERE user_id=$1 AND date=$2', [userId, today]);
    const merged = { ...(existing.rows[0]?.data || {}), ...Object.fromEntries(Object.entries(incoming).map(([k,v]) => [k, parseFloat(v)])) };

    await pool.query(`
      INSERT INTO shortcut_readings (user_id, date, data, timestamp)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (user_id,date) DO UPDATE
      SET data = $3, timestamp = NOW()
    `, [userId, today, merged]);

    res.json({ ok: true, saved: merged });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---- LOG HISTORY ----
app.get('/shortcut-history', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await pool.query('SELECT * FROM shortcut_readings WHERE user_id=$1 ORDER BY date DESC LIMIT 30', [userId]);
    if (result.rows.length) return res.json(result.rows);
    // fallback
    const data = loadShortcutData();
    const sorted = Object.entries(data).sort((a,b)=>b[0].localeCompare(a[0])).map(([date, vals])=>({date, ...vals}));
    res.json(sorted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---- ADD EXTRA FIELDS TO LOG HISTORY ----
app.post('/shortcut-history/:date', isAuthenticated, async (req, res) => {
  const { date } = req.params;
  const updates = req.body;
  if (!updates || typeof updates !== 'object') return res.status(400).json({ message: 'Invalid body' });

  try {
    const userId = req.session.user.id;
    const existing = await pool.query('SELECT data FROM shortcut_readings WHERE user_id=$1 AND date=$2', [userId, date]);
    const merged = { ...(existing.rows[0]?.data || {}), ...updates };
    await pool.query(`
      INSERT INTO shortcut_readings (user_id,date,data,timestamp)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (user_id,date) DO UPDATE
      SET data=$3, timestamp=NOW()
    `, [userId,date,merged]);
    res.json({ ok: true, saved: merged });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---- SERVE APP ----
app.get('/', async (req, res) => {
  const filePath = path.join(__dirname,'giorno.html');
  try {
    let html = readFileSync(filePath,'utf8');
    if (req.isAuthenticated()) {
      const injection = `<script>
window.__GIORNO_USER__ = ${JSON.stringify(req.session.user)};
</script>`;
      html = html.replace('</head>', injection+'\n</head>');
    }
    res.setHeader('Content-Type','text/html');
    res.send(html);
  } catch {
    res.status(404).send('giorno.html not found');
  }
});

app.use((req,res)=>res.status(404).send('Not found'));

// ---- START ----
initDb().then(()=>app.listen(PORT,()=>console.log(`Giorno server running on port ${PORT}`))).catch(err=>{
  console.error('Failed to init database:', err);
  process.exit(1);
});
