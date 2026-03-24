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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

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
  `);

  console.log('Database ready');
}

const app = express();
app.use(express.json({ limit: '10mb' }));

app.set('trust proxy', 1);

app.use(session({
  store: new PgSession({ pool, tableName: 'sessions' }),
  secret: process.env.SESSION_SECRET || 'giorno-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ message: 'Unauthorized' });
}

app.get('/api/login', async (req, res) => {
  try {
    const user = {
      id: 'stephanie',
      email: 'stephaniebarchiesi@gmail.com',
      first_name: 'Stephanie',
      last_name: 'Barchiesi',
      is_paid: true,
      is_owner: true
    };

    await pool.query(`
      INSERT INTO users (id, email, first_name, last_name, is_paid, is_owner)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO NOTHING
    `, [
      user.id,
      user.email,
      user.first_name,
      user.last_name,
      user.is_paid,
      user.is_owner
    ]);

    req.logIn(user, (err) => {
      if (err) {
        console.error('Login error:', err);
        return res.status(500).json({ message: 'Login failed' });
      }

      return res.json({ ok: true, user });
    });
  } catch (err) {
    console.error('Login route error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// IMPORTANT: no isAuthenticated here
app.post('/shortcut', async (req, res) => {
  const { user_id, hrv, hr, sleep } = req.body;
  const today = new Date().toISOString().split('T')[0];

  if (!user_id) {
    return res.status(400).json({ message: 'Missing user_id' });
  }

  try {
    await pool.query(`
      INSERT INTO shortcut_readings (user_id, date, hrv, hr, sleep)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      user_id,
      today,
      hrv != null ? parseFloat(hrv) : null,
      hr != null ? parseFloat(hr) : null,
      sleep != null ? parseFloat(sleep) : null
    ]);

    return res.json({ ok: true });
  } catch (err) {
    console.error('Shortcut error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/data', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(`
      SELECT key, value, created_at
      FROM user_data
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);

    return res.json(result.rows);
  } catch (err) {
    console.error('User data fetch error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/data', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const updates = req.body;

    for (const [key, value] of Object.entries(updates)) {
      await pool.query(`
        INSERT INTO user_data (user_id, key, value)
        VALUES ($1, $2, $3)
      `, [userId, key, JSON.stringify(value)]);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('User data insert error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

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

    return res.json({
      readings: readingsResult.rows,
      logs: logsResult.rows
    });
  } catch (err) {
    console.error('History fetch error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.get('/', (req, res) => {
  const filePath = join(__dirname, 'giorno.html');

  try {
    let html = readFileSync(filePath, 'utf8');

    if (req.isAuthenticated()) {
      const injection = `<script>window.__GIORNO_USER__ = ${JSON.stringify(req.user)};</script>`;
      const headClose = html.indexOf('</head>');

      if (headClose !== -1) {
        html = html.slice(0, headClose) + injection + html.slice(headClose);
      }
    }

    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  } catch {
    return res.status(404).send('giorno.html not found');
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('DB init failed:', err);
  });
