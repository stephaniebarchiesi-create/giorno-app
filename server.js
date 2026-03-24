import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import passport from 'passport';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;
const PgSession = connectPgSimple(session);
const PORT = process.env.PORT || 5000;

// ---- DATABASE ----
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

    CREATE TABLE IF NOT EXISTS user_data (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR NOT NULL,
      key VARCHAR NOT NULL,
      value JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS shortcut_readings (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR NOT NULL,
      date DATE NOT NULL,
      entry_time TIMESTAMP DEFAULT NOW(),
      hrv FLOAT,
      hr FLOAT,
      sleep FLOAT
    );

    CREATE INDEX IF NOT EXISTS idx_shortcut_user_date ON shortcut_readings(user_id, date);
  `);
  console.log('Database ready');
}

// ---- EXPRESS ----
const app = express();
app.use(express.json({ limit: '10mb' }));

// ---- SESSION ----
app.set('trust proxy', 1); // needed for Render HTTPS proxy
app.use(session({
  store: new PgSession({ pool, tableName: 'sessions' }),
  secret: process.env.SESSION_SECRET || 'giorno-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: true, // must be true for HTTPS
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

// ---- AUTH ----
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Unauthorized' });
}

// ---- LOGIN: real account ----
app.get('/api/login', async (req, res) => {
  const user = {
    id: 'stephanie',
    email: 'stephaniebarchiesi@gmail.com',
    first_name: 'Stephanie',
    last_name: 'Barchiesi',
    is_paid: true,
    is_owner: true
  };

  // insert into DB if not exists
  await pool.query(`
    INSERT INTO users (id, email, first_name, last_name, is_paid, is_owner)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO NOTHING
  `, [user.id, user.email, user.first_name, user.last_name, user.is_paid, user.is_owner]);

  req.logIn(user, err => {
    if (err) return res.status(500).json({ message: 'Login failed' });
    res.json({ ok: true, user });
  });
});

// ---- SHORTCUTS ----
app.post('/shortcut', isAuthenticated, async (req, res) => {
  const { hrv, hr, sleep } = req.body;
  const userId = req.user.id;
  const today = new Date().toISOString().split('T')[0];

  try {
    await pool.query(`
      INSERT INTO shortcut_readings (user_id, date, hrv, hr, sleep)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      userId,
      today,
      hrv != null ? parseFloat(hrv) : null,
      hr != null ? parseFloat(hr) : null,
      sleep != null ? parseFloat(sleep) : null
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Shortcut error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---- USER DATA (daily logs) ----
app.get('/api/data', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(`
      SELECT key, value, created_at
      FROM user_data
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error('User data fetch error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/data', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const updates = req.body; // { key: value }
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(`
        INSERT INTO user_data (user_id, key, value)
        VALUES ($1, $2, $3)
      `, [userId, key, JSON.stringify(value)]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('User data insert error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---- HISTORY ----
app.get('/history', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;

    const readingsResult = await pool.query(`
      SELECT *
      FROM shortcut_readings
      WHERE user_id = $1
      ORDER BY date DESC, entry_time DESC
    `, [userId]);

    const logsResult = await pool.query(`
      SELECT *
      FROM user_data
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);

    res.json({
      readings: readingsResult.rows,
      logs: logsResult.rows
    });
  } catch (err) {
    console.error('History fetch error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---- SERVE HTML ----
app.get('/', (req, res) => {
  const filePath = join(__dirname, 'giorno.html');
  try {
    let html = readFileSync(filePath, 'utf8');
    if (req.isAuthenticated()) {
      const user = req.user;
      const injection = `<script>window.__GIORNO_USER__ = ${JSON.stringify(user)};</script>`;
      const headClose = html.indexOf('</head>');
      if (headClose !== -1) {
        html = html.slice(0, headClose) + injection + html.slice(headClose);
      }
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch {
    res.status(404).send('giorno.html not found');
  }
});

// ---- START SERVER ----
initDb().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => console.error('DB init failed:', err));
