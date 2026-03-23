const express = require('express');
const pg = require('pg');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());

// ---------- INIT DB ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE,
      token TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS readings (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      hrv FLOAT,
      hr FLOAT,
      sleep FLOAT,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, date)
    );
  `);

  console.log('DB ready');
}

// ---------- HELPERS ----------
function generateToken() {
  return 'sc_' + crypto.randomBytes(16).toString('hex');
}

async function getUserByToken(token) {
  const result = await pool.query(
    'SELECT * FROM users WHERE token = $1',
    [token]
  );
  return result.rows[0];
}

// ---------- LOGIN (GET for easy testing) ----------
app.get('/api/login', async (req, res) => {
  try {
    const email = req.query.email;

    if (!email) {
      return res.send('Add ?email=you@example.com');
    }

    let result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    let user;

    if (result.rows.length > 0) {
      user = result.rows[0];
    } else {
      const token = generateToken();
      result = await pool.query(
        'INSERT INTO users (email, token) VALUES ($1, $2) RETURNING *',
        [email, token]
      );
      user = result.rows[0];
    }

    res.json({
      email: user.email,
      token: user.token
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('error');
  }
});

// ---------- SHORTCUT ----------
app.get('/shortcut', async (req, res) => {
  try {
    const { token, hrv, hr, sleep } = req.query;

    if (!token) return res.status(400).json({ error: 'Missing token' });

    const user = await getUserByToken(token);
    if (!user) return res.status(404).json({ error: 'Invalid token' });

    const today = new Date().toISOString().split('T')[0];

    await pool.query(`
      INSERT INTO readings (user_id, date, hrv, hr, sleep)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, date) DO UPDATE SET
        hrv = COALESCE(EXCLUDED.hrv, readings.hrv),
        hr = COALESCE(EXCLUDED.hr, readings.hr),
        sleep = COALESCE(EXCLUDED.sleep, readings.sleep),
        updated_at = NOW()
    `, [
      user.id,
      today,
      hrv ? parseFloat(hrv) : null,
      hr ? parseFloat(hr) : null,
      sleep ? parseFloat(sleep) : null
    ]);

    console.log(`Saved for ${user.email}`);

    res.json({ ok: true });

  } catch (err) {
    console.error(err);
    res.status(500).send('error');
  }
});

// ---------- GET TODAY ----------
app.get('/api/today', async (req, res) => {
  try {
    const { token } = req.query;

    const user = await getUserByToken(token);
    if (!user) return res.json({});

    const today = new Date().toISOString().split('T')[0];

    const result = await pool.query(
      'SELECT * FROM readings WHERE user_id = $1 AND date = $2',
      [user.id, today]
    );

    res.json(result.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.json({});
  }
});

// ---------- HISTORY ----------
app.get('/api/history', async (req, res) => {
  try {
    const { token } = req.query;

    const user = await getUserByToken(token);
    if (!user) return res.json([]);

    const result = await pool.query(
      'SELECT * FROM readings WHERE user_id = $1 ORDER BY date DESC LIMIT 30',
      [user.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ---------- HEALTH ----------
app.get('/health', (req, res) => {
  res.send('OK');
});

// ---------- START ----------
initDb().then(() => {
  app.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
  });
});
