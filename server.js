// ---- SERVE APP ----
app.get('/', async (req, res) => {
  const filePath = join(__dirname, 'giorno.html');
  try {
    let html = readFileSync(filePath, 'utf8');

    if (req.isAuthenticated()) {
      try {
        const userId = req.user.id || req.user.claims.sub;

        const [userResult, dataResult] = await Promise.all([
          pool.query('SELECT * FROM users WHERE id = $1', [userId]),
          pool.query('SELECT key, value FROM user_data WHERE user_id = $1', [userId])
        ]);

        const user = userResult.rows[0];
        const userData = {};
        dataResult.rows.forEach(row => { userData[row.key] = row.value; });

        // Inject only the user info (token removed)
        const injection = `<script>
window.__GIORNO_USER__ = ${JSON.stringify({
  id: user.id,
  email: user.email,
  firstName: user.first_name,
  lastName: user.last_name,
  isPaid: user.is_paid || user.is_owner,
  isOwner: user.is_owner
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

// ---- SECURE SHORTCUT TOKEN ----
app.get('/api/shortcut-token', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id || req.user.claims.sub;
    const result = await pool.query('SELECT token FROM shortcut_tokens WHERE user_id = $1', [userId]);

    if (result.rows.length === 0) {
      // create a new token if none exists
      const token = 'sc_' + Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      await pool.query('INSERT INTO shortcut_tokens (user_id, token) VALUES ($1, $2)', [userId, token]);
      return res.json({ token });
    }

    res.json({ token: result.rows[0].token });
  } catch (err) {
    console.error('Error fetching shortcut token:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---- SHORTCUT ENDPOINT ----
app.get('/shortcut', async (req, res) => {
  const { hrv, hr, sleep, token } = req.query;
  const today = new Date().toISOString().split('T')[0];
  const sleepVal = parseSleep(sleep);

  if (token) {
    try {
      const tokenResult = await pool.query('SELECT user_id FROM shortcut_tokens WHERE token = $1', [token]);
      if (tokenResult.rows.length > 0) {
        const userId = tokenResult.rows[0].user_id;

        // Allow multiple entries per day: use timestamp as unique
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
    } catch (err) {
      console.error('Shortcut DB error:', err);
    }
  }

  res.status(400).json({ message: 'Invalid token or data' });
});

// ---- LOG HISTORY ----
app.get('/shortcut-history', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id || req.user.claims.sub;
    const result = await pool.query(
      'SELECT * FROM shortcut_readings WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 50',
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching history:', err);
    res.status(500).json({ message: 'Server error' });
  }
});
