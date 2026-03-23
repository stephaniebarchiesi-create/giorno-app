const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'shortcut-data.json');

function loadShortcutData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveShortcutData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (pathname === '/shortcut') {
    const data = loadShortcutData();
    const today = new Date().toISOString().split('T')[0];

    data[today] = {
      hrv: query.hrv ? parseFloat(query.hrv) : null,
      hr: query.hr ? parseFloat(query.hr) : null,
      sleep: query.sleep ? Math.round(parseFloat(query.sleep) / 3600 * 10) / 10 : null,
      timestamp: new Date().toISOString()
    };

    saveShortcutData(data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, saved: data[today] }));
    return;
  }

  if (pathname === '/shortcut-data') {
    const data = loadShortcutData();
    const today = new Date().toISOString().split('T')[0];
    const todayData = data[today] || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(todayData));
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    const filePath = path.join(__dirname, 'giorno.html');
    try {
      const html = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('giorno.html not found');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Giorno server running on port ${PORT}`);
});
