import express from 'express';
import pg from 'pg';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;
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

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function makeUserId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    is_paid: !!row.is_paid,
    is_owner: !!row.is_owner,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function requireAuth(req, res, next) {
  try {
    const token = req.headers['x-access-token'];

    if (!token || typeof token !== 'string') {
      return res.status(401).json({ message: 'Missing token' });
    }

    const result = await pool.query(
      `
      SELECT id, username, is_paid, is_owner, created_at, updated_at
      FROM users
      WHERE auth_token = $1
      LIMIT 1
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    req.user = sanitizeUser(result.rows[0]);
    req.authToken = token;
    return next();
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ message: 'Authentication failed' });
  }
}

// ---------- DB INIT + MIGRATION ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR PRIMARY KEY,
      username TEXT UNIQUE,
      password_hash TEXT,
      auth_token TEXT UNIQUE,
      email VARCHAR UNIQUE,
      first_name VARCHAR,
      last_name VARCHAR,
      is_paid BOOLEAN DEFAULT FALSE,
      is_owner BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Add newer auth columns safely for older deployments
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS username TEXT;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_hash TEXT;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS auth_token TEXT;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT FALSE;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_owner BOOLEAN DEFAULT FALSE;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_idx
    ON users (username)
    WHERE username IS NOT NULL;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_auth_token_unique_idx
    ON users (auth_token)
    WHERE auth_token IS NOT NULL;
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
    CREATE INDEX IF NOT EXISTS idx_user_data_user_created
    ON user_data(user_id, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_data_user_key
    ON user_data(user_id, key);
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
      GREATEST(COALESCE((SELECT MAX(id) FROM shortcut_readings), 1), 1),
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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_shortcut_readings_user_entry_time
    ON shortcut_readings(user_id, entry_time DESC);
  `);

  console.log('Database ready');
}

// ---------- APP SETUP ----------
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

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

// ---------- AUTH ----------
app.post('/api/signup', async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || '');

    if (!username) {
      return res.status(400).json({ message: 'Username is required' });
    }

    if (username.length < 3 || username.length > 40) {
      return res.status(400).json({ message: 'Username must be 3-40 characters' });
    }

    if (!/^[a-z0-9._-]+$/.test(username)) {
      return res.status(400).json({
        message: 'Username can only contain letters, numbers, dots, underscores, and dashes'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const existing = await pool.query(
      `SELECT id FROM users WHERE username = $1 LIMIT 1`,
      [username]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ message: 'Username already exists' });
    }

    const id = makeUserId();
    const passwordHash = await bcrypt.hash(password, 10);
    const token = makeToken();

    const result = await pool.query(
      `
      INSERT INTO users (
        id,
        username,
        password_hash,
        auth_token,
        is_paid,
        is_owner,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, FALSE, FALSE, NOW(), NOW())
      RETURNING id, username, auth_token, is_paid, is_owner, created_at, updated_at
      `,
      [id, username, passwordHash, token]
    );

    const user = sanitizeUser(result.rows[0]);

    return res.json({
      ok: true,
      token,
      user
    });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ message: 'Signup failed', detail: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || '');

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    const result = await pool.query(
      `
      SELECT id, username, password_hash, is_paid, is_owner, created_at, updated_at
      FROM users
      WHERE username = $1
      LIMIT 1
      `,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const user = result.rows[0];

    if (!user.password_hash) {
      return res.status(400).json({
        message: 'This account does not have a password set yet'
      });
    }

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const token = makeToken();

    await pool.query(
      `
      UPDATE users
      SET auth_token = $1, updated_at = NOW()
      WHERE id = $2
      `,
      [token, user.id]
    );

    return res.json({
      ok: true,
      token,
      user: sanitizeUser({
        ...user,
        updated_at: new Date()
      })
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ message: 'Login failed', detail: err.message });
  }
});

app.post('/api/logout', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `
      UPDATE users
      SET auth_token = NULL, updated_at = NOW()
      WHERE id = $1
      `,
      [req.user.id]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({ message: 'Logout failed', detail: err.message });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  return res.json({ ok: true, user: req.user });
});

// ---------- SHORTCUT ROUTE ----------
// Apple Shortcuts should send x-access-token in headers.
// user_id is no longer accepted from the request body.
app.post('/shortcut', requireAuth, async (req, res) => {
  console.log('SHORTCUT BODY:', JSON.stringify(req.body, null, 2));

  try {
    const userId = req.user.id;
    const { hrv, hr, sleep, date } = req.body || {};

    const safeDate =
      typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : new Date().toISOString().split('T')[0];

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

    await pool.query(
      `
      INSERT INTO shortcut_readings (user_id, date, entry_time, hrv, hr, sleep)
      VALUES ($1, $2, NOW(), $3, $4, $5)
      `,
      [userId, safeDate, hrvNum, hrNum, sleepNum]
    );

    return res.json({
      ok: true,
      saved: {
        user_id: userId,
        date: safeDate,
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
app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `
      SELECT id, key, value, created_at
      FROM user_data
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [userId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('User data fetch error:', err);
    return res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

app.post('/api/data', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const updates = req.body;

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ message: 'Body must be an object' });
    }

    for (const [key, value] of Object.entries(updates)) {
      await pool.query(
        `
        INSERT INTO user_data (user_id, key, value)
        VALUES ($1, $2, $3)
        `,
        [userId, key, JSON.stringify(value)]
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('User data insert error:', err);
    return res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// ---------- HISTORY ----------
app.get('/history', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const readingsResult = await pool.query(
      `
      SELECT *
      FROM shortcut_readings
      WHERE user_id = $1
      ORDER BY date DESC, entry_time DESC
      `,
      [userId]
    );

    const logsResult = await pool.query(
      `
      SELECT *
      FROM user_data
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [userId]
    );

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
    const html = readFileSync(filePath, 'utf8');
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
