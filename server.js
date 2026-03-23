import express from 'express';
import session from 'express-session';
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
      id SERIAL PRIMARY KEY,
      email VARCHAR UNIQUE,
      first_name VARCHAR,
      last_name VARCHAR,
      is_owner BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_data (
      user_id INT NOT NULL,
      key VARCHAR NOT NULL,
      value JSONB,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS shortcut_tokens (
      user_id INT PRIMARY KEY,
      token VARCHAR UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS shortcut_readings (
      user_id INT NOT NULL,
      date VARCHAR NOT NULL,
      hrv FLOAT,
      hr FLOAT,
      sleep FLOAT,
      timestamp TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, date)
    );
  `);
  console.log('Database ready');
}

// ---- LEGACY FILE STORAGE ----
function loadShortcutData() {
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveShortcutData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ---- EXPRESS APP ----
const app = express();
app.use(express.json({ limit: '10mb' }));

// ---- SESSION ----
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'giorno-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7*24*60*60*1000 }
}));

// ---- CORS for shortcuts ----
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---- AUTH SIMPLIFIED ----
app.use((req, res, next) => {
  // simulate logged-in user for testing
  req.user = { id: 1 }; 
  next();
});

// ---- CREATE/GET SHORTCUT TOKEN ----
app.get('/api/shortcut-token', async (req,res)=>{
  if (!req.user?.id) return res.status(401).json({error:'unauthorized'});
  try {
    const existing = await pool.query('SELECT token FROM shortcut_tokens WHERE user_id=$1',[req.user.id]);
    if (existing.rows.length) return res.json({token: existing.rows[0].token});

    const token = 'sc_' + crypto.randomBytes(16).toString('hex');
    await pool.query('INSERT INTO shortcut_tokens(user_id,token) VALUES($1,$2)',[req.user.id,token]);
    res.json({token});
  } catch(err){ console.error(err); res.status(500).json({error:'server error'}); }
});

// ---- SHORTCUT ENDPOINT ----
app.get('/shortcut', async (req, res) => {
  const { token, hrv, hr, sleep } = req.query;
  const today = new Date().toISOString().split('T')[0];

  if (token) {
    try {
      const result = await pool.query('SELECT user_id FROM shortcut_tokens WHERE token=$1',[token]);
      if (result.rows.length) {
        const userId = result.rows[0].user_id;
        await pool.query(`
          INSERT INTO shortcut_readings (user_id, date, hrv, hr, sleep, timestamp)
          VALUES ($1,$2,$3,$4,$5,NOW())
          ON CONFLICT (user_id,date) DO UPDATE SET
            hrv = COALESCE(EXCLUDED.hrv, shortcut_readings.hrv),
            hr = COALESCE(EXCLUDED.hr, shortcut_readings.hr),
            sleep = COALESCE(EXCLUDED.sleep, shortcut_readings.sleep),
            timestamp = NOW()
        `, [
          userId,
          today,
          hrv ? parseFloat(hrv) : null,
          hr ? parseFloat(hr) : null,
          sleep ? parseFloat(sleep) : null
        ]);
        return res.json({ok:true});
      }
    } catch(err){ console.error('DB error /shortcut:', err); }
  }

  // fallback
  const data = loadShortcutData();
  data[today] = {
    hrv: hrv ? parseFloat(hrv) : null,
    hr: hr ? parseFloat(hr) : null,
    sleep: sleep ? parseFloat(sleep) : null,
    timestamp: new Date().toISOString()
  };
  saveShortcutData(data);
  res.json({ok:true,saved:data[today]});
});

// ---- GET TODAY DATA ----
app.get('/shortcut-data', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  if (req.user?.id) {
    try {
      const result = await pool.query('SELECT * FROM shortcut_readings WHERE user_id=$1 AND date=$2',[req.user.id,today]);
      if (result.rows.length) return res.json(result.rows[0]);
    } catch(err){ console.error(err); }
  }
  const data = loadShortcutData();
  res.json(data[today] || {});
});

// ---- GET HISTORY ----
app.get('/shortcut-history', async (req,res)=>{
  if (req.user?.id){
    try{
      const result = await pool.query('SELECT * FROM shortcut_readings WHERE user_id=$1 ORDER BY date DESC LIMIT 30',[req.user.id]);
      if (result.rows.length) return res.json(result.rows);
    }catch(err){console.error(err);}
  }
  const data = loadShortcutData();
  const sorted = Object.entries(data).sort((a,b)=>b[0].localeCompare(a[0])).map(([date,val])=>({date,...val}));
  res.json(sorted);
});

// ---- SIMPLE HEALTH CHECK ----
app.get('/health',(req,res)=>res.send('OK'));

// ---- SERVE STATIC HTML ----
app.get('/', (req,res)=>{
  const filePath = join(__dirname,'giorno.html');
  if (existsSync(filePath)){
    const html = readFileSync(filePath,'utf8');
    res.setHeader('Content-Type','text/html');
    res.end(html);
  } else res.status(404).send('giorno.html not found');
});

// ---- CATCHALL ----
app.use((req,res)=>res.status(404).send('Not found'));

// ---- START SERVER ----
initDb().then(()=>{
  app.listen(PORT,()=>console.log(`Giorno server running on port ${PORT}`));
}).catch(err=>{
  console.error('Failed to init DB:',err);
  process.exit(1);
});
