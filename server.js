import express from 'express';
import session from 'express-session';
import passport from 'passport';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import crypto from 'crypto';

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
      user_id VARCHAR NOT NULL,
      date VARCHAR NOT NULL,
      hrv FLOAT,
      hr FLOAT,
      sleep FLOAT,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, date)
    );
  `);
  console.log('Database ready');
}

// ---- EXPRESS ----
const app = express();
app.use(express.json({ limit: '10mb' }));

// ---- SESSION ----
app.use(session({
  store: new PgSession({ pool, tableName: 'sessions' }),
  secret: process.env.SESSION_SECRET || 'giorno-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
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

app.get('/api/login', async (req, res) => {
  const testUser = {
    id: 'test-user',
    email: 'stephaniebarchiesi@gmail.com',
    first_name: 'Stephanie',
    last_name: 'Barchiesi',
    is_paid: true,
    is_owner: true
  };

  await pool.query(`
    INSERT INTO users (id, email, first_name, last_name, is_paid, is_owner)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO NOTHING
  `, [testUser.id, testUser.email, testUser.first_name, testUser.last_name, testUser.is_paid, testUser.is_owner]);

  req.logIn(testUser, err => {
    if (err) return res.status(500).json({ message: 'Login failed' });
    res.json({ ok: true, user: testUser });
  });
});

// ---- SHORTCUTS ----
app.get('/shortcut', async (req, res) => {
  const { hrv, hr, sleep, user_id } = req.query;
  if (!user_id) return res.status(400).json({ message: 'Missing user_id' });

  const today = new Date().toISOString().split('T')[0];
  const sleepVal = sleep ? parseFloat(sleep) : null;

  try {
    await pool.query(`
      INSERT INTO shortcut_readings (user_id, date, hrv, hr, sleep, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (user_id, date) DO UPDATE
        SET hrv = COALESCE(EXCLUDED.hrv, shortcut_readings.hrv),
            hr = COALESCE(EXCLUDED.hr, shortcut_readings.hr),
            sleep = COALESCE(EXCLUDED.sleep, shortcut_readings.sleep),
            updated_at = NOW()
    `, [user_id, today, hrv ? parseFloat(hrv) : null, hr ? parseFloat(hr) : null, sleepVal]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Shortcut error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---- USER DATA (additive logs) ----
app.get('/api/data', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const result = await pool.query('SELECT key, value, created_at FROM user_data WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  res.json(result.rows);
});

app.post('/api/data', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const updates = req.body; // { key: value }
  try {
    for (const [key, value] of Object.entries(updates)) {
      await pool.query('INSERT INTO user_data (user_id, key, value) VALUES ($1, $2, $3)', [userId, key, JSON.stringify(value)]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---- HISTORY ----
app.get('/history', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const readings = await pool.query('SELECT * FROM shortcut_readings WHERE user_id = $1 ORDER BY date DESC', [userId]);
  const logs = await pool.query('SELECT * FROM user_data WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  res.json({ readings: readings.rows, logs: logs.rows });
});

// ---- SERVE HTML ----
app.get('/', (req, res) => {
  const filePath = join(__dirname, 'giorno.html');
  try {
    let html = readFileSync(filePath, 'utf8');
    if (req.isAuthenticated()) {
      const user = req.user;
      const injection = `<script>
window.__GIORNO_USER__ = ${JSON.stringify(user)};
</script>`;
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

// ---- START ----
initDb().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
});
