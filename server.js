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

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false
});

// ---------- HELPERS ----------
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ message: 'Unauthorized' });
}

function toNumberOrNull(value, decimals = null) {
  if (value === null || value === undefined || value === '') return null;

  let num = null;

  if (typeof value === 'number') {
    num = Number.isFinite(value) ? value : null;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    num = Number.isFinite(parsed) ? parsed : null;
  }

  if (num === null) return null;

  if (decimals !== null) {
    return Number(num.toFixed(decimals));
  }

  return num;
}

// ---------- DB INIT + MIGRATION ----------
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
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_data (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR NOT NULL,
      key VARCHAR NOT NULL,
      value JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shortcut_readings (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR NOT NULL,
      date DATE NOT NULL,
      entry_time TIMESTAMP DEFAULT NOW(),
      hrv DOUBLE PRECISION,
      hr DOUBLE PRECISION,
      sleep DOUBLE PRECISION
    );
  `);

  // Repair older versions of shortcut_readings
  await pool.query(`
    ALTER TABLE shortcut_readings
    ADD COLUMN IF NOT EXISTS id BIGINT;
  `);

  await pool.query(`
    ALTER TABLE shortcut_readings
    ADD COLUMN IF NOT EXISTS entry_time TIMESTAMP DEFAULT NOW();
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE relkind = 'S'
          AND relname = 'shortcut_readings_id_seq'
      ) THEN
        CREATE SEQUENCE shortcut_readings_id_seq;
      END IF;
    END
    $$;
  `);

  await pool.query(`
    ALTER SEQUENCE shortcut_readings_id_seq OWNED BY shortcut_readings.id;
  `);

  await pool.query(`
    ALTER TABLE shortcut_readings
    ALTER COLUMN id SET DEFAULT nextval('shortcut_readings_id_seq');
  `);

  await pool.query(`
    UPDATE shortcut_readings
    SET id = nextval('shortcut_readings_id_seq')
    WHERE id IS NULL;
  `);

  await pool.query(`
    SELECT setval(
      'shortcut_readings_id_seq',
      COALESCE((SELECT MAX(id) FROM shortcut_readings), 1),
      true
    );
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'shortcut_readings_pkey'
      ) THEN
        ALTER TABLE shortcut_readings DROP CONSTRAINT shortcut_readings_pkey;
      END IF;
    END
    $$;
  `);

  await pool.query(`
    ALTER TABLE shortcut_readings
    ALTER COLUMN id SET NOT NULL;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'shortcut_readings_id_pkey'
      ) THEN
        ALTER TABLE shortcut_readings ADD PRIMARY KEY (id);
      END IF;
    END
    $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_shortcut_readings_user_date
    ON shortcut_readings(user_id, date);
  `);

  console.log('Database ready');
}

// ---------- APP SETUP ----------
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: 'sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'giorno-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

// ---------- HEALTHCHECK ----------
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ ok: true });
  } catch (err) {
    console.error('Healthcheck failed:', err);
    return res.status(500).json({ ok: false, message: 'Database unavailable' });
  }
});

// ---------- LOGIN ----------
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
      INSERT INTO users (id, email, first_name, last_name, is_paid, is_owner, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        is_paid = EXCLUDED.is_paid,
        is_owner = EXCLUDED.is_owner,
        updated_at = NOW()
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
    return res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

app.get('/api/logout', (req, res) => {
  req.logout?.((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ message: 'Logout failed' });
    }

    req.session.destroy(() => {
      return res.json({ ok: true });
    });
  });
});

// ---------- SHORTCUT ROUTE ----------
// No browser auth here. Apple Shortcuts posts directly with user_id.
app.post('/shortcut', async (req, res) => {
  console.log('SHORTCUT BODY:', JSON.stringify(req.body, null, 2));

  try {
    const { user_id, hrv, hr, sleep } = req.body;
    const today = new Date().toISOString().split('T')[0];

    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ message: 'Missing user_id' });
    }

    // Rounded on the server so Shortcuts float weirdness does not matter
    const hrvNum = toNumberOrNull(hrv, 1);
    const hrNum = toNumberOrNull(hr, 1);
    const sleepNum = toNumberOrNull(sleep, 1);

    if (hrv !== undefined && hrvNum === null) {
      return res.status(400).json({ message: 'Invalid hrv value' });
    }
    if (hr !== undefined && hrNum === null) {
      return res.status(400).json({ message: 'Invalid hr value' });
    }
    if (sleep !== undefined && sleepNum === null) {
      return res.status(400).json({ message: 'Invalid sleep value' });
    }

    await pool.query(`
      INSERT INTO shortcut_readings (user_id, date, entry_time, hrv, hr, sleep)
      VALUES ($1, $2, NOW(), $3, $4, $5)
    `, [user_id, today, hrvNum, hrNum, sleepNum]);

    return res.json({
      ok: true,
      saved: {
        user_id,
        date: today,
        hrv: hrvNum,
        hr: hrNum,
        sleep: sleepNum
      }
    });
  } catch (err) {
    console.error('Shortcut error full:', err);
    return res.status(500).json({
      message: 'Server error',
      detail: err.message
    });
  }
});

// ---------- USER DATA ----------
app.get('/api/data', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(`
      SELECT id, key, value, created_at
      FROM user_data
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);

    return res.json(result.rows);
  } catch (err) {
    console.error('User data fetch error:', err);
    return res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

app.post('/api/data', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const updates = req.body;

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ message: 'Body must be an object' });
    }

    for (const [key, value] of Object.entries(updates)) {
      await pool.query(`
        INSERT INTO user_data (user_id, key, value)
        VALUES ($1, $2, $3)
      `, [userId, key, JSON.stringify(value)]);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('User data insert error:', err);
    return res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// ---------- HISTORY ----------
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
    return res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// ---------- HOME ----------
app.get('/', (req, res) => {
  const filePath = join(__dirname, 'giorno.html');

  try {
    let html = readFileSync(filePath, 'utf8');

    if (req.isAuthenticated && req.isAuthenticated()) {
      const injection = `<script>window.__GIORNO_USER__ = ${JSON.stringify(req.user)};</script>`;
      const headClose = html.indexOf('</head>');

      if (headClose !== -1) {
        html = html.slice(0, headClose) + injection + html.slice(headClose);
      }
    }

    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  } catch (err) {
    console.error('HTML read error:', err);
    return res.status(404).send('giorno.html not found');
  }
});

// ---------- START ----------
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
