import express from 'express';
import { db, nowIso, newId } from './db.js';

const app = express();
app.use(express.json({ limit: '512kb' }));

const PERSON_FIELDS = [
  'given_name','surname','birth_name','gender',
  'birth_date','birth_place','death_date','death_place','notes'
];

function sanitizePerson(body) {
  const out = {};
  for (const f of PERSON_FIELDS) {
    const v = body?.[f];
    if (v == null) continue;
    if (typeof v !== 'string') throw httpErr(400, `${f} must be string`);
    if (v.length > 500) throw httpErr(400, `${f} too long`);
    out[f] = v.trim() || null;
  }
  if (out.gender && !['m','f','x',''].includes(out.gender)) {
    throw httpErr(400, 'gender must be m, f or x');
  }
  return out;
}

function httpErr(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/* persons --------------------------------------------------------------- */

app.get('/api/persons', (_req, res) => {
  const rows = db.prepare('SELECT * FROM persons ORDER BY surname, given_name').all();
  res.json(rows);
});

app.post('/api/persons', (req, res) => {
  const data = sanitizePerson(req.body || {});
  const id = newId();
  const now = nowIso();
  db.prepare(`
    INSERT INTO persons (id, given_name, surname, birth_name, gender,
      birth_date, birth_place, death_date, death_place, notes, created_at, updated_at)
    VALUES (@id,@given_name,@surname,@birth_name,@gender,
      @birth_date,@birth_place,@death_date,@death_place,@notes,@created_at,@updated_at)
  `).run({
    id, given_name:null, surname:null, birth_name:null, gender:null,
    birth_date:null, birth_place:null, death_date:null, death_place:null, notes:null,
    ...data, created_at: now, updated_at: now,
  });
  res.status(201).json(db.prepare('SELECT * FROM persons WHERE id=?').get(id));
});

app.get('/api/persons/:id', (req, res) => {
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(req.params.id);
  if (!person) return res.status(404).json({ error: 'not found' });
  const edges = db.prepare('SELECT * FROM edges WHERE from_id=? OR to_id=?')
    .all(req.params.id, req.params.id);
  res.json({ person, edges });
});

app.patch('/api/persons/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM persons WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const data = sanitizePerson(req.body || {});
  if (!Object.keys(data).length) return res.status(400).json({ error: 'no fields' });
  const set = Object.keys(data).map(k => `${k}=@${k}`).join(', ');
  db.prepare(`UPDATE persons SET ${set}, updated_at=@updated_at WHERE id=@id`)
    .run({ ...data, id: req.params.id, updated_at: nowIso() });
  res.json(db.prepare('SELECT * FROM persons WHERE id=?').get(req.params.id));
});

app.delete('/api/persons/:id', (req, res) => {
  const info = db.prepare('DELETE FROM persons WHERE id=?').run(req.params.id);
  res.json({ deleted: info.changes });
});

/* edges ----------------------------------------------------------------- */

app.get('/api/edges', (_req, res) => {
  res.json(db.prepare('SELECT * FROM edges').all());
});

app.post('/api/edges', (req, res) => {
  const { from_id, to_id, type, since, until } = req.body || {};
  if (!from_id || !to_id || from_id === to_id) {
    return res.status(400).json({ error: 'from_id and to_id required, must differ' });
  }
  if (!['parent','spouse'].includes(type)) {
    return res.status(400).json({ error: 'type must be parent or spouse' });
  }
  const a = db.prepare('SELECT id FROM persons WHERE id=?').get(from_id);
  const b = db.prepare('SELECT id FROM persons WHERE id=?').get(to_id);
  if (!a || !b) return res.status(400).json({ error: 'unknown person id' });

  // dedupe: for parent, (from,to) directed; for spouse, treat as unordered.
  let dup;
  if (type === 'parent') {
    dup = db.prepare('SELECT id FROM edges WHERE from_id=? AND to_id=? AND type=?')
      .get(from_id, to_id, 'parent');
  } else {
    dup = db.prepare(`SELECT id FROM edges WHERE type='spouse' AND
      ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))`)
      .get(from_id, to_id, to_id, from_id);
  }
  if (dup) return res.status(409).json({ error: 'edge exists', id: dup.id });

  const id = newId();
  db.prepare(`INSERT INTO edges (id, from_id, to_id, type, since, until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, from_id, to_id, type, since || null, until || null, nowIso());
  res.status(201).json(db.prepare('SELECT * FROM edges WHERE id=?').get(id));
});

app.delete('/api/edges/:id', (req, res) => {
  const info = db.prepare('DELETE FROM edges WHERE id=?').run(req.params.id);
  res.json({ deleted: info.changes });
});

/* tree ------------------------------------------------------------------ */

app.get('/api/tree', (_req, res) => {
  const persons = db.prepare('SELECT * FROM persons').all();
  const edges = db.prepare('SELECT * FROM edges').all();
  res.json({ persons, edges });
});

/* ai research stub ------------------------------------------------------ */

app.post('/api/ai/research', (req, res) => {
  const { person_id, prompt } = req.body || {};
  if (!person_id) return res.status(400).json({ error: 'person_id required' });
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(person_id);
  if (!person) return res.status(404).json({ error: 'person not found' });

  const id = newId();
  const now = nowIso();
  const effectivePrompt = String(prompt || '').slice(0, 2000)
    || `Ahnenforschung: finde mögliche Eltern, Geschwister und Lebensdaten für ${person.given_name || ''} ${person.surname || ''}, geboren ${person.birth_date || '?'} in ${person.birth_place || '?'}.`;

  // Stub: records the request, returns a placeholder.  Real LLM call wires in later.
  const suggestion = {
    person: `${person.given_name || ''} ${person.surname || ''}`.trim() || person.id,
    hinweise: [
      'KI-Research ist noch nicht angebunden. Dieser Endpunkt protokolliert nur den Prompt.',
      'Nächster Schritt: ANTHROPIC_API_KEY setzen und Modell-Call ergänzen.',
    ],
    prompt: effectivePrompt,
  };

  db.prepare(`INSERT INTO ai_runs (id, person_id, prompt, model, response, status, created_at, completed_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, person_id, effectivePrompt, 'stub', JSON.stringify(suggestion), 'completed', now, now);

  res.json({ id, status: 'completed', ...suggestion });
});

app.get('/api/ai/runs/:person_id', (req, res) => {
  const rows = db.prepare('SELECT id, prompt, model, status, created_at, completed_at FROM ai_runs WHERE person_id=? ORDER BY created_at DESC LIMIT 20')
    .all(req.params.person_id);
  res.json(rows);
});

/* health ---------------------------------------------------------------- */

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: nowIso() }));

/* error handling -------------------------------------------------------- */

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'internal error' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`stammbaum-api listening on :${PORT}`));
