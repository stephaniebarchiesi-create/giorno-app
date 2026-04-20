import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import passport from 'passport';
import * as oidc from 'openid-client';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;
const PgSession = connectPgSimple(session);
const PORT = process.env.PORT || 5000;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const GOOGLE_ISSUER = new URL('https://accounts.google.com');

const app = express();
let googleConfigPromise = null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false
});

function isAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ message: 'Unauthorized' });
}

function isGoogleAuthConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

async function getGoogleConfig() {
  if (!isGoogleAuthConfigured()) {
    throw new Error('Google sign-in is not configured yet');
  }

  if (!googleConfigPromise) {
    googleConfigPromise = oidc.discovery(
      GOOGLE_ISSUER,
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
  }

  return googleConfigPromise;
}

function getGoogleCallbackUrl() {
  return new URL('/auth/google/callback', APP_BASE_URL).toString();
}

function sanitizeReturnTo(value) {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) {
    return value;
  }
  return '/';
}

function buildUserPayload(row, extras = {}) {
  const firstName = row.first_name || row.firstName || '';
  const lastName = row.last_name || row.lastName || '';
  return {
    id: row.id,
    email: row.email || '',
    firstName,
    lastName,
    name: [firstName, lastName].filter(Boolean).join(' '),
    isPaid: Boolean(row.is_paid ?? row.isPaid),
    isOwner: Boolean(row.is_owner ?? row.isOwner),
    ...extras
  };
}

function hasValidMaintenanceKey(req) {
  const expected = process.env.MAINTENANCE_KEY;
  const provided = req.query.key || req.headers['x-maintenance-key'];
  return Boolean(expected && provided && provided === expected);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, expectedHash] = storedHash.split(':');
  const actualHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

function logUserIn(req, res, user, successResponder) {
  req.logIn(user, (err) => {
    if (err) {
      console.error('Session login error:', err);
      return res.status(500).json({ message: 'Could not open your session' });
    }

    return req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Session save error:', saveErr);
        return res.status(500).json({ message: 'Could not save your session' });
      }

      return successResponder();
    });
  });
}

function renderAuthBridge({ title, body, redirectTo, actionLabel = 'Continue', tone = 'default' }) {
  const safeTitle = String(title || 'Connecting...');
  const safeBody = String(body || '');
  const safeRedirect = String(redirectTo || '/');
  const toneStyles =
    tone === 'error'
      ? 'background: linear-gradient(180deg, #fff8f2 0%, #fff 100%); border-color: rgba(184, 90, 90, 0.18);'
      : 'background: linear-gradient(180deg, #f7f6f1 0%, #fffdfa 100%); border-color: rgba(87, 112, 86, 0.14);';

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${safeTitle}</title>
      <style>
        :root { color-scheme: light; }
        body {
          margin: 0;
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 24px;
          font-family: "DM Sans", system-ui, sans-serif;
          background: #f6f2eb;
          color: #2d2820;
        }
        .auth-bridge {
          width: min(460px, 100%);
          border: 1px solid rgba(45, 40, 32, 0.08);
          border-radius: 24px;
          padding: 28px 24px;
          box-shadow: 0 20px 60px rgba(45, 40, 32, 0.08);
          ${toneStyles}
        }
        .auth-mark {
          font-size: 12px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #786a59;
          margin-bottom: 10px;
          font-weight: 600;
        }
        h1 {
          font-family: "Lora", Georgia, serif;
          font-size: 28px;
          line-height: 1.1;
          margin: 0 0 10px;
        }
        p {
          margin: 0;
          color: #584b3f;
          line-height: 1.7;
          font-size: 15px;
        }
        .auth-actions {
          display: flex;
          gap: 10px;
          margin-top: 18px;
          flex-wrap: wrap;
        }
        a, button {
          border: none;
          border-radius: 999px;
          padding: 12px 16px;
          text-decoration: none;
          cursor: pointer;
          font: inherit;
        }
        .primary {
          background: #2d2820;
          color: #faf7f2;
        }
        .secondary {
          background: rgba(45, 40, 32, 0.08);
          color: #2d2820;
        }
      </style>
    </head>
    <body>
      <div class="auth-bridge">
        <div class="auth-mark">Giorno</div>
        <h1>${safeTitle}</h1>
        <p>${safeBody}</p>
        <div class="auth-actions">
          <a class="primary" href="${safeRedirect}">${actionLabel}</a>
          <a class="secondary" href="/">Back to Giorno</a>
        </div>
      </div>
      <script>
        setTimeout(() => {
          window.location.replace(${JSON.stringify(safeRedirect)});
        }, 900);
      </script>
    </body>
  </html>`;
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

async function getLatestUserDataValue(userId, key) {
  const result = await pool.query(
    `
    SELECT value
    FROM user_data
    WHERE user_id = $1 AND key = $2
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [userId, key]
  );

  return result.rows[0]?.value ?? null;
}

async function saveUserDataValue(userId, key, value) {
  await pool.query(
    `
    INSERT INTO user_data (user_id, key, value)
    VALUES ($1, $2, $3)
    `,
    [userId, key, JSON.stringify(value)]
  );
}

async function getLatestUserDataSnapshot(userId) {
  const result = await pool.query(
    `
    SELECT DISTINCT ON (key) key, value
    FROM user_data
    WHERE user_id = $1
    ORDER BY key, created_at DESC
    `,
    [userId]
  );

  return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
}

async function resolveShortcutUser({ token, userId }) {
  if (token) {
    const result = await pool.query(
      `
      SELECT user_id
      FROM user_data
      WHERE key = 'shortcut_token' AND value = to_jsonb($1::text)
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [token]
    );
    return result.rows[0]?.user_id ?? null;
  }

  if (userId && typeof userId === 'string') {
    return userId;
  }

  return null;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR PRIMARY KEY,
      email VARCHAR UNIQUE,
      first_name VARCHAR,
      last_name VARCHAR,
      password_hash TEXT,
      auth_provider VARCHAR DEFAULT 'local',
      is_paid BOOLEAN DEFAULT FALSE,
      is_owner BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_hash TEXT;
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS auth_provider VARCHAR DEFAULT 'local';
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
    ALTER TABLE user_data
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
  `);

  await pool.query(`
    UPDATE user_data
    SET created_at = NOW()
    WHERE created_at IS NULL;
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

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

app.use(
  session({
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
  })
);

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ ok: true });
  } catch (err) {
    console.error('Healthcheck failed:', err);
    return res.status(500).json({ ok: false, message: 'Database unavailable' });
  }
});

app.post('/api/signup', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const firstName = String(req.body?.firstName || '').trim();

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const existing = await pool.query(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (existing.rows[0]) {
      return res.status(409).json({ message: 'An account with that email already exists' });
    }

    const dbUser = {
      id: `local_${crypto.randomUUID()}`,
      email,
      first_name: firstName,
      last_name: '',
      password_hash: hashPassword(password),
      auth_provider: 'local',
      is_paid: false,
      is_owner: false
    };

    await pool.query(
      `
      INSERT INTO users (id, email, first_name, last_name, password_hash, auth_provider, is_paid, is_owner, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      `,
      [
        dbUser.id,
        dbUser.email,
        dbUser.first_name,
        dbUser.last_name,
        dbUser.password_hash,
        dbUser.auth_provider,
        dbUser.is_paid,
        dbUser.is_owner
      ]
    );

    const user = buildUserPayload(dbUser);
    return logUserIn(req, res, user, () => res.json({ ok: true, user }));
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ message: 'Could not create your account' });
  }
});

app.post('/api/login/password', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const result = await pool.query(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );
    const row = result.rows[0];

    if (!row || row.auth_provider !== 'local' || !verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ message: 'Incorrect email or password' });
    }

    const user = buildUserPayload(row);
    return logUserIn(req, res, user, () => res.json({ ok: true, user }));
  } catch (err) {
    console.error('Password login error:', err);
    return res.status(500).json({ message: 'Could not sign you in' });
  }
});

app.get('/api/login', async (req, res) => {
  try {
    if (!isGoogleAuthConfigured()) {
      return res.redirect('/?auth_error=google_not_configured');
    }

    const config = await getGoogleConfig();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const returnTo = sanitizeReturnTo(req.query.returnTo);

    req.session.authFlow = {
      provider: 'google',
      codeVerifier,
      state,
      nonce,
      returnTo
    };

    const authUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: getGoogleCallbackUrl(),
      scope: 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      prompt: 'select_account'
    });

    return req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Could not persist auth session before redirect:', saveErr);
        return res.redirect('/?auth_error=signin_failed');
      }

      return res.redirect(authUrl.href);
    });
  } catch (err) {
    console.error('Login route error:', err);
    return res.redirect('/?auth_error=signin_failed');
  }
});

app.get('/auth/google/callback', async (req, res) => {
  const authFlow = req.session.authFlow;

  if (!authFlow || authFlow.provider !== 'google') {
    return res
      .status(400)
      .send(
        renderAuthBridge({
          title: 'That sign-in session expired',
          body: 'Please head back to Giorno and start Google sign-in again. This usually happens if the browser lost the temporary login session.',
          redirectTo: '/?auth_error=missing_auth_session',
          actionLabel: 'Try sign-in again',
          tone: 'error'
        })
      );
  }

  try {
    const config = await getGoogleConfig();
    const currentUrl = new URL(req.originalUrl, APP_BASE_URL);
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: authFlow.codeVerifier,
      expectedState: authFlow.state,
      expectedNonce: authFlow.nonce
    });
    const claims = tokens.claims();

    if (!claims?.sub || !claims?.email) {
      throw new Error('Google did not return a usable account profile');
    }

    const dbUser = {
      id: `google_${claims.sub}`,
      email: claims.email,
      first_name: claims.given_name || '',
      last_name: claims.family_name || '',
      is_paid: false,
      is_owner: false
    };

    await pool.query(
      `
      INSERT INTO users (id, email, first_name, last_name, is_paid, is_owner, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        updated_at = NOW()
      `,
      [
        dbUser.id,
        dbUser.email,
        dbUser.first_name,
        dbUser.last_name,
        dbUser.is_paid,
        dbUser.is_owner
      ]
    );

    const user = buildUserPayload(dbUser);
    delete req.session.authFlow;

    req.logIn(user, (err) => {
      if (err) {
        console.error('Google login session error:', err);
        return res
          .status(500)
          .send(
            renderAuthBridge({
              title: 'Google connected, but Giorno could not finish signing you in',
              body: 'The app reached Google successfully, but the local session could not be opened. Please go back and try once more.',
              redirectTo: '/?auth_error=session_failed',
              actionLabel: 'Back to Giorno',
              tone: 'error'
            })
          );
      }

      return req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Could not persist signed-in session after Google callback:', saveErr);
          return res
            .status(500)
            .send(
              renderAuthBridge({
                title: 'Giorno could not save your sign-in',
                body: 'Google returned successfully, but the app could not save the new signed-in session. Please try again in a moment.',
                redirectTo: '/?auth_error=session_failed',
                actionLabel: 'Back to Giorno',
                tone: 'error'
              })
            );
        }

        return res.send(
          renderAuthBridge({
            title: 'Google sign-in connected',
            body: 'You’re signed in now. Giorno is reopening with sync enabled.',
            redirectTo: `${sanitizeReturnTo(authFlow.returnTo)}?auth=google_connected`,
            actionLabel: 'Open Giorno'
          })
        );
      });
    });
  } catch (err) {
    delete req.session.authFlow;
    console.error('Google callback error:', err);
    return res
      .status(500)
      .send(
        renderAuthBridge({
          title: 'Google sign-in did not finish correctly',
          body: `Giorno received the callback, but something in the final step failed. ${err?.message ? `Details: ${String(err.message)}` : ''}`.trim(),
          redirectTo: '/?auth_error=google_callback_failed',
          actionLabel: 'Back to Giorno',
          tone: 'error'
        })
      );
  }
});

app.get('/api/logout', (req, res) => {
  req.logout?.((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ message: 'Logout failed' });
    }

    req.session.destroy(() => {
      if ((req.headers.accept || '').includes('text/html')) {
        return res.redirect('/?signed_out=1');
      }
      return res.json({ ok: true });
    });
  });
});

app.post('/api/shortcut-token', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const existing = await getLatestUserDataValue(userId, 'shortcut_token');
    if (typeof existing === 'string' && existing) {
      return res.json({ ok: true, token: existing });
    }

    const token = 'giorno_' + crypto.randomBytes(16).toString('hex');
    await saveUserDataValue(userId, 'shortcut_token', token);
    return res.json({ ok: true, token });
  } catch (err) {
    console.error('Shortcut token error:', err);
    return res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

app.post('/shortcut', async (req, res) => {
  console.log('SHORTCUT BODY:', JSON.stringify(req.body, null, 2));

  try {
    const token = req.query.token || req.body.token;
    const providedUserId = req.body.user_id;
    const { hrv, hr, sleep } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const userId = await resolveShortcutUser({ token, userId: providedUserId });

    if (!userId) {
      return res.status(400).json({ message: 'Missing or invalid shortcut token/user_id' });
    }

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
      [userId, today, hrvNum, hrNum, sleepNum]
    );

    return res.json({
      ok: true,
      saved: {
        user_id: userId,
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

app.get('/shortcut-data', isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT user_id, date, entry_time, hrv, hr, sleep
      FROM shortcut_readings
      WHERE user_id = $1
      ORDER BY date DESC, entry_time DESC
      LIMIT 1
      `,
      [req.user.id]
    );

    return res.json(result.rows[0] || {});
  } catch (err) {
    console.error('Shortcut data fetch error:', err);
    return res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

app.get('/shortcut-history', isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT user_id, date, entry_time, hrv, hr, sleep
      FROM shortcut_readings
      WHERE user_id = $1
      ORDER BY date DESC, entry_time DESC
      LIMIT 20
      `,
      [req.user.id]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('Shortcut history fetch error:', err);
    return res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

app.get('/api/data', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `
      SELECT key, value, created_at
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

app.get('/api/data/snapshot', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const snapshot = await getLatestUserDataSnapshot(userId);
    return res.json(snapshot);
  } catch (err) {
    console.error('User snapshot fetch error:', err);
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

app.post('/api/data/:key', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const key = req.params.key;
    const value = req.body?.value;

    if (!key) {
      return res.status(400).json({ message: 'Missing key' });
    }

    await saveUserDataValue(userId, key, value);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Single user data insert error:', err);
    return res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

app.delete('/api/account', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;

    await pool.query('DELETE FROM shortcut_readings WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM user_data WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    req.logout?.((err) => {
      if (err) {
        console.error('Account delete logout error:', err);
        return res.status(500).json({ message: 'Account deleted, but sign-out failed' });
      }

      req.session.destroy(() => {
        return res.json({ ok: true });
      });
    });
  } catch (err) {
    console.error('Delete account error:', err);
    return res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

app.get('/history', isAuthenticated, async (req, res) => {
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

// Temporary maintenance route for clearing duplicate test accounts.
app.get('/api/admin/cleanup-sync-test-accounts', async (req, res) => {
  if (!hasValidMaintenanceKey(req)) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const targetEmails = [
    'nikkisixxchikk@aol.com',
    'stephaniebarchiesi@gmail.com'
  ];

  try {
    const usersResult = await pool.query(
      `
      SELECT id, email
      FROM users
      WHERE lower(email) = ANY($1)
      `,
      [targetEmails.map((email) => email.toLowerCase())]
    );

    const userIds = usersResult.rows.map((row) => row.id);

    if (userIds.length > 0) {
      await pool.query('DELETE FROM shortcut_readings WHERE user_id = ANY($1)', [userIds]);
      await pool.query('DELETE FROM user_data WHERE user_id = ANY($1)', [userIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    }

    return res.json({
      ok: true,
      deletedEmails: usersResult.rows.map((row) => row.email),
      deletedCount: usersResult.rows.length
    });
  } catch (err) {
    console.error('Cleanup sync test accounts error:', err);
    return res.status(500).json({ message: 'Could not delete accounts', detail: err.message });
  }
});

app.get('/', (req, res) => {
  const filePath = join(__dirname, 'giorno.html');

  try {
    let html = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error('HTML read error:', err);
    return res.status(404).send('giorno.html not found');
  }

  const sendHtml = async () => {
    try {
      let html = readFileSync(filePath, 'utf8');

      if (req.isAuthenticated && req.isAuthenticated()) {
        try {
          const shortcutToken = await getLatestUserDataValue(req.user.id, 'shortcut_token');
          const userData = await getLatestUserDataSnapshot(req.user.id);
          const user = buildUserPayload(req.user, {
            shortcutToken: typeof shortcutToken === 'string' ? shortcutToken : null
          });
          const injection = `<script>window.__GIORNO_USER__ = ${JSON.stringify(user)};window.__GIORNO_DATA__ = ${JSON.stringify(userData)};</script>`;
          const headClose = html.indexOf('</head>');

          if (headClose !== -1) {
            html = html.slice(0, headClose) + injection + html.slice(headClose);
          }
        } catch (injectErr) {
          console.error('Auth bootstrap injection error:', injectErr);
        }
      }

      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    } catch (err) {
      console.error('HTML read/inject error:', err);
      return res.status(500).send('Could not load giorno.html');
    }
  };

  return sendHtml();
});

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
