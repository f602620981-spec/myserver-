const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));


// লোকাল ফাইল বেসড ডাটাবেজ পাথ (যate কোনো এক্সট্রা ডাটাবেজের ঝামেলা না লাগে)
const DATA_FILE = path.join(__dirname, 'users_data.json');

// ডাটা ফাইল রিড করার ফাংশন
function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify([]));
    }
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading data file:', err);
    return [];
  }
}

// ডাটা ফাইল রাইট করার ফাংশন
function writeData(rows) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error('Error writing data file:', err);
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function applyFilter(rows, query) {
  let result = rows;
  if (query.email && query.email.startsWith('eq.')) {
    const email = normalizeEmail(query.email.slice(3));
    result = result.filter(r => normalizeEmail(r.email) === email);
  }
  if (query.email && query.email.startsWith('neq.')) {
    const email = normalizeEmail(query.email.slice(4));
    result = result.filter(r => normalizeEmail(r.email) !== email);
  }
  if (query.order) {
    const m = String(query.order).match(/^(updated_at|created_at)(?:\.(asc|desc))?$/i);
    if (m) {
      const field = m[1];
      const desc = String(m[2] || 'asc').toLowerCase() === 'desc';
      result = result.slice().sort((a, b) => {
        const av = a.__meta?.[field] ? new Date(a.__meta[field]).getTime() : 0;
        const bv = b.__meta?.[field] ? new Date(b.__meta[field]).getTime() : 0;
        return desc ? bv - av : av - bv;
      });
    }
  }
  if (query.limit) result = result.slice(0, Math.max(0, Number(query.limit) || 0));
  return result;
}

function rowsForApi(dbRows) {
  return dbRows.map(r => ({ ...(r.data || {}), email: r.email, __meta: { created_at: r.created_at, updated_at: r.updated_at } }));
}

function cleanMeta(row) {
  if (!row) return row;
  const out = { ...row };
  delete out.__meta;
  return out;
}

app.get('/', (req, res) => {
  res.json({ success: true, server: 'Linux AI Cloud Free Server', status: 'online' });
});

// Supabase style compatibility API
app.get('/rest/v1/linux_ai_users', (req, res) => {
  try {
    const rawRows = readData();
    let rows = applyFilter(rowsForApi(rawRows), req.query).map(cleanMeta);
    if (req.query.select && req.query.select !== '*') {
      const fields = String(req.query.select).split(',').map(x => x.trim()).filter(Boolean);
      rows = rows.map(row => {
        const picked = {};
        fields.forEach(field => { if (Object.prototype.hasOwnProperty.call(row, field)) picked[field] = row[field]; });
        return picked;
      });
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/rest/v1/linux_ai_users', (req, res) => {
  try {
    let rawRows = readData();
    const incoming = Array.isArray(req.body) ? req.body : [req.body];
    
    for (const user of incoming) {
      if (!user || !user.email) continue;
      const email = normalizeEmail(user.email);
      const data = { ...user, email };
      const now = new Date().toISOString();

      const existingIndex = rawRows.findIndex(r => normalizeEmail(r.email) === email);
      if (existingIndex >= 0) {
        rawRows[existingIndex].data = data;
        rawRows[existingIndex].updated_at = now;
      } else {
        rawRows.push({
          email,
          data,
          created_at: now,
          updated_at: now
        });
      }
    }
    writeData(rawRows);
    res.status(201).json([]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/rest/v1/linux_ai_users', (req, res) => {
  try {
    let rawRows = readData();
    const targets = applyFilter(rowsForApi(rawRows), req.query);
    const now = new Date().toISOString();

    for (const target of targets) {
      const email = normalizeEmail(target.email);
      const index = rawRows.findIndex(r => normalizeEmail(r.email) === email);
      if (index === -1) continue;

      const updated = { ...rawRows[index].data, ...req.body, email };
      rawRows[index].data = updated;
      rawRows[index].updated_at = now;
    }
    writeData(rawRows);
    res.json([]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/rest/v1/linux_ai_users', (req, res) => {
  try {
    let rawRows = readData();
    const targets = applyFilter(rowsForApi(rawRows), req.query);
    const emailsToDelete = new Set(targets.map(t => normalizeEmail(t.email)));

    rawRows = rawRows.filter(r => !emailsToDelete.has(normalizeEmail(r.email)));
    writeData(rawRows);
    res.json([]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/users', (req, res) => {
  const rawRows = readData();
  res.json(rawRows.map(r => r.data));
});

app.get('/users/:email', (req, res) => {
  const email = normalizeEmail(decodeURIComponent(req.params.email));
  const rawRows = readData();
  const found = rawRows.find(r => normalizeEmail(r.email) === email);
  if (!found) return res.status(404).json({ error: 'User not found' });
  res.json(found.data);
});

app.post('/users', (req, res) => {
  const user = req.body || {};
  if (!user.email) return res.status(400).json({ error: 'email is required' });
  const email = normalizeEmail(user.email);
  const data = { ...user, email };
  const now = new Date().toISOString();

  let rawRows = readData();
  const existingIndex = rawRows.findIndex(r => normalizeEmail(r.email) === email);
  
  if (existingIndex >= 0) {
    rawRows[existingIndex].data = data;
    rawRows[existingIndex].updated_at = now;
  } else {
    rawRows.push({ email, data, created_at: now, updated_at: now });
  }
  writeData(rawRows);
  res.json(data);
});

app.patch('/users/:email', (req, res) => {
  const email = normalizeEmail(decodeURIComponent(req.params.email));
  let rawRows = readData();
  const found = rawRows.find(r => normalizeEmail(r.email) === email);
  if (!found) return res.status(404).json({ error: 'User not found' });

  const now = new Date().toISOString();
  found.data = { ...found.data, ...req.body, email };
  found.updated_at = now;

  writeData(rawRows);
  res.json(found.data);
});

app.delete('/users/:email', (req, res) => {
  const email = normalizeEmail(decodeURIComponent(req.params.email));
  let rawRows = readData();
  const index = rawRows.findIndex(r => normalizeEmail(r.email) === email);
  if (index === -1) return res.status(404).json({ error: 'User not found' });

  const deleted = rawRows.splice(index, 1)[0];
  writeData(rawRows);
  res.json({ success: true, deleted: deleted.data });
});

// সেলফ-পিং লজিক (নিরাপদ পদ্ধতিতে রিকোয়েস্ট পাঠানোর জন্য)
setInterval(() => {
  const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const client = appUrl.startsWith('https') ? https : http;
  client.get(appUrl, (res) => {
    // রেসপন্স হ্যান্ডেল করার জন্য
  }).on('error', (err) => {
    // ইগনোর করা যাতে ক্র্যাশ না করে
  });
}, 30000); // ৩০ সেকেন্ড পর পর পিং পাঠানো নিরাপদ

app.listen(PORT, '0.0.0.0', () => {
  console.log('================================');
  console.log(' Linux AI Free Cloud Server Started');
  console.log(' Port: ' + PORT);
  console.log('================================');
});
