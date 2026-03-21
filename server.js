import express from 'express';
import session from 'express-session';
import passport from 'passport';
import connectPgSimple from 'connect-pg-simple';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import pg from 'pg';
import * as oidcClient from 'openid-client';
import memoize from 'memoizee';

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
      timestamp TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, date)
    );
  `);
  console.log('Database tables ready');
}

async function upsertUser(claims) {
  const id = claims.sub;
  const email = claims.email || null;
  const firstName = claims.first_name || null;
  const lastName = claims.last_name || null;
  const profileImageUrl = claims.profile_image_url || null;

  const existing = await pool.query('SELECT id, is_owner FROM users WHERE id = $1', [id]);
  const ownerEmail = process.env.OWNER_EMAIL;
  const isFirstUser = existing.rows.length === 0;
  const allUsers = await pool.query('SELECT COUNT(*) FROM users');
  const isOwner = (ownerEmail && email === ownerEmail) || (allUsers.rows[0].count === '0');

  await pool.query(`
    INSERT INTO users (id, email, first_name, last_name, profile_image_url, is_owner, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      profile_image_url = EXCLUDED.profile_image_url,
      is_owner = CASE WHEN users.is_owner THEN TRUE ELSE EXCLUDED.is_owner END,
      updated_at = NOW()
  `, [id, email, firstName, lastName, profileImageUrl, isOwner]);

  const user = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return user.rows[0];
}

// ---- OIDC AUTH ----
const getOidcConfig = memoize(async () => {
  return await oidcClient.discovery(
    new URL(process.env.ISSUER_URL || 'https://replit.com/oidc'),
    process.env.REPL_ID
  );
}, { maxAge: 3600 * 1000, promise: true });

// ---- SHORTCUT DATA (legacy file-based, for backward compat) ----
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
    if (parts.length === 2) {
      val = parts[0] <= 24 ? parts[0] + parts[1] / 60 : (parts[0] * 60 + parts[1]) / 3600;
    }
  } else {
    val = parseFloat(s);
    if (val > 1440) val = val / 3600;
    else if (val > 24) val = val / 60;
  }
  return val != null ? parseFloat(val.toFixed(2)) : null;
}

// ---- APP ----
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

// ---- SESSION ----
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: false, tableName: 'sessions' }),
  secret: process.env.SESSION_SECRET || 'giorno-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: !!(process.env.REPLIT_DOMAINS || process.env.NODE_ENV === 'production'), sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

// ---- AUTH MIDDLEWARE ----
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Unauthorized' });
}

// ---- AUTH ROUTES ----

// Simple test login for dev / free access
app.get('/api/login', async (req, res) => {
  try {
    const testUser = {
      claims: {
        sub: 'test-user-1',
        email: 'stephaniebarchiesi@gmail.com',
        first_name: 'Stephanie',
        last_name: 'Barchiesi'
      }
    };

    // Create user in DB if not exists
    await pool.query(`
      INSERT INTO users (id, email, first_name, last_name, is_owner)
      VALUES ($1, $2, $3, $4, true)
      ON CONFLICT (id) DO NOTHING
    `, [testUser.claims.sub, testUser.claims.email, testUser.claims.first_name, testUser.claims.last_name]);

    // Log user into session
    await new Promise((resolve, reject) => {
      req.logIn(testUser, err => err ? reject(err) : resolve());
    });

    // Save session
    await new Promise((resolve, reject) => {
      req.session.save(err => err ? reject(err) : resolve());
    });

    // Redirect to home
    res.redirect('/');

  } catch (err) {
    console.error('Test login error:', err);
    res.status(500).send('Login failed');
  }
});

// OIDC callback route (real login, optional)
app.get('/api/callback', async (req, res) => {
  try {
    const config = await getOidcConfig();
    const { codeVerifier, state } = req.session.oidc || {};

    if (!codeVerifier) {
      console.error('Callback: no PKCE verifier in session');
      return res.redirect('/api/login');
    }

    const callbackURL = `https://${req.hostname}/api/callback`;
    const currentUrl = new URL(callbackURL + '?' + new URLSearchParams(req.query).toString());

    const tokens = await oidcClient.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
    });

    const claims = tokens.claims();
    const dbUser = await upsertUser(claims);

    const sessionUser = {
      claims,
      dbUser,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    };

    req.session.oidc = null;
    await new Promise((resolve, reject) => req.logIn(sessionUser, err => err ? reject(err) : resolve()));
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));

    res.redirect('/');
  } catch (err) {
    console.error('Callback error:', err.message);
    res.redirect('/api/login');
});

// ---- USER DATA API ----
app.get('/api/data', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.claims.sub;
    const result = await pool.query('SELECT key, value FROM user_data WHERE user_id = $1', [userId]);
    const data = {};
    result.rows.forEach(row => { data[row.key] = row.value; });
    res.json(data);
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/data', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.claims.sub;
    const updates = req.body;
    if (typeof updates !== 'object' || Array.isArray(updates)) return res.status(400).json({ message: 'Expected object' });
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(`
        INSERT INTO user_data (user_id, key, value, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [userId, key, JSON.stringify(value)]);
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/data/:key', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.claims.sub;
    const { key } = req.params;
    const { value } = req.body;
    await pool.query(`
      INSERT INTO user_data (user_id, key, value, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [userId, key, JSON.stringify(value)]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// ---- SHORTCUT TOKEN ----
app.post('/api/shortcut-token', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.claims.sub;
    const token = 'sc_' + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    await pool.query(`
      INSERT INTO shortcut_tokens (user_id, token) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token
    `, [userId, token]);
    res.json({ token });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// ---- APPLE SHORTCUT ENDPOINT (token-based, works without session) ----
app.get('/shortcut', async (req, res) => {
  const { hrv, hr, sleep, token } = req.query;
  const today = new Date().toISOString().split('T')[0];
  const sleepVal = parseSleep(sleep);

  if (token) {
    try {
      const tokenResult = await pool.query('SELECT user_id FROM shortcut_tokens WHERE token = $1', [token]);
      if (tokenResult.rows.length > 0) {
        const userId = tokenResult.rows[0].user_id;
        const existing = await pool.query('SELECT * FROM shortcut_readings WHERE user_id = $1 AND date = $2', [userId, today]);
        const ex = existing.rows[0] || {};
        await pool.query(`
          INSERT INTO shortcut_readings (user_id, date, hrv, hr, sleep, timestamp)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (user_id, date) DO UPDATE SET
            hrv = COALESCE(EXCLUDED.hrv, shortcut_readings.hrv),
            hr = COALESCE(EXCLUDED.hr, shortcut_readings.hr),
            sleep = COALESCE(EXCLUDED.sleep, shortcut_readings.sleep),
            timestamp = NOW()
        `, [userId, today, hrv ? parseFloat(hrv) : null, hr ? parseFloat(hr) : null, sleepVal]);
        console.log(`Shortcut data saved for user ${userId} on ${today}`);
        return res.json({ ok: true });
      }
    } catch (err) { console.error('Shortcut DB error:', err); }
  }

  // Legacy file-based fallback (for personal use before accounts)
  const data = loadShortcutData();
  const existing = data[today] || {};
  data[today] = {
    hrv: hrv ? parseFloat(hrv) : existing.hrv ?? null,
    hr: hr ? parseFloat(hr) : existing.hr ?? null,
    sleep: sleepVal !== null ? sleepVal : existing.sleep ?? null,
    timestamp: new Date().toISOString()
  };
  saveShortcutData(data);
  console.log(`Shortcut data (legacy) for ${today}:`, data[today]);
  res.json({ ok: true, saved: data[today] });
});

app.get('/shortcut-data', isAuthenticated, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const userId = req.user.claims.sub;
    const result = await pool.query('SELECT * FROM shortcut_readings WHERE user_id = $1 AND date = $2', [userId, today]);
    if (result.rows.length > 0) return res.json(result.rows[0]);
  } catch (err) { console.error(err); }
  const data = loadShortcutData();
  res.json(data[today] || {});
});

app.get('/shortcut-data-unauth', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const data = loadShortcutData();
  res.json(data[today] || {});
});

app.get('/shortcut-history', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.claims.sub;
    const result = await pool.query('SELECT * FROM shortcut_readings WHERE user_id = $1 ORDER BY date DESC LIMIT 30', [userId]);
    if (result.rows.length > 0) return res.json(result.rows);
  } catch (err) { console.error(err); }
  const data = loadShortcutData();
  const sorted = Object.entries(data).sort((a, b) => b[0].localeCompare(a[0])).map(([date, vals]) => ({ date, ...vals }));
  res.json(sorted);
});

// ---- SERVE APP ----
app.get('/', async (req, res) => {
  const filePath = join(__dirname, 'giorno.html');
  try {
    let html = readFileSync(filePath, 'utf8');

    if (req.isAuthenticated()) {
      try {
        const userId = req.user.claims.sub;
        const [userResult, dataResult, tokenResult] = await Promise.all([
          pool.query('SELECT * FROM users WHERE id = $1', [userId]),
          pool.query('SELECT key, value FROM user_data WHERE user_id = $1', [userId]),
          pool.query('SELECT token FROM shortcut_tokens WHERE user_id = $1', [userId])
        ]);
        const user = userResult.rows[0];
        const userData = {};
        dataResult.rows.forEach(row => { userData[row.key] = row.value; });
        const shortcutToken = tokenResult.rows[0]?.token || null;

        const injection = `<script>
window.__GIORNO_USER__ = ${JSON.stringify({
  id: user.id,
  email: user.email,
  firstName: user.first_name,
  lastName: user.last_name,
  isPaid: user.is_paid || user.is_owner,
  isOwner: user.is_owner,
  shortcutToken
})};
window.__GIORNO_DATA__ = ${JSON.stringify(userData)};
</script>`;
        const headClose = html.indexOf('</head>');
        if (headClose !== -1) {
          html = html.slice(0, headClose) + injection + '\n</head>' + html.slice(headClose + 7);
        }
      } catch (err) {
        console.error('Error injecting user data:', err);
      }
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch {
    res.status(404).send('giorno.html not found');
  }
});

app.use((req, res) => res.status(404).send('Not found'));

// ---- START ----
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Giorno server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to see the app`);
    console.log(`Shortcut endpoint: http://localhost:${PORT}/shortcut?token=YOUR_TOKEN&hrv=42&hr=68`);
  });
}).catch(err => {
  console.error('Failed to init database:', err);
  process.exit(1);
});
