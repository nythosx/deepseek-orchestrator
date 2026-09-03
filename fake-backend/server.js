const express = require('express');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 8080;
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Alias so http://localhost:8080/chat works the same as /chat.html
app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

function loadScenario(name) {
  // Re-read on every call (no cache) — scenario JSON is edited iteratively during
  // development and a stale in-memory copy is a confusing failure mode to debug.
  const file = path.join(SCENARIOS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// sessionKey -> next turn index
const sessions = new Map();

app.post('/api/simulate', (req, res) => {
  const { prompt, context, taskId, scenario } = req.body || {};
  if (!context) {
    return res.status(400).json({ error: 'context is required (planner|executor)' });
  }

  const scenarioData = loadScenario(scenario || 'default');
  if (!scenarioData || !scenarioData[context]) {
    return res.status(404).json({ error: `no scenario turns for context "${context}"` });
  }

  const turns = scenarioData[context];
  const sessionKey = `${taskId || 'dev'}:${context}`;
  const turnIndex = sessions.get(sessionKey) || 0;
  const reply = turns[Math.min(turnIndex, turns.length - 1)];
  sessions.set(sessionKey, turnIndex + 1);

  const delay = 400 + Math.random() * 800;
  setTimeout(() => {
    res.json({ reply, turnIndex });
  }, delay);
});

// Dev convenience: reset session turn counters without restarting the server.
app.post('/api/reset', (req, res) => {
  sessions.clear();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Mock DeepSeek chat backend listening on http://localhost:${PORT}/chat`);
});
