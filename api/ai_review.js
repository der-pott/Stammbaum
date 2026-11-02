// AI-Review: analysiert alle Daten einer Person via Claude, schlägt
// Ergänzungen (Personen, Edges, Residences, Felder, Widersprüche) als
// JSON-Vorschläge vor. User reviewt + wendet selektiv an.

const MODEL = process.env.ANTHROPIC_AI_REVIEW_MODEL || 'claude-opus-4-7';

const SYSTEM_PROMPT = `Du bist Genealogie-Analyst. Du bekommst die vollständigen Daten einer Person plus das Namensregister aller bereits erfassten Personen. Analysiere die Freitext-Felder (notes, anecdote-text, document-captions) und finde:

1. ERWÄHNTE PERSONEN die noch nicht in der DB sind. Beispiel: Notes "Vater von Iris-Andrea, verheiratet mit Giesela Sehnke geb. Elsner" → wenn Giesela nicht in Namensregister → als new_person vorschlagen.
2. ABLEITBARE BEZIEHUNGEN. Beispiel: "Vater von X" → parent-edge von dieser Person zu X. "Verheiratet mit Y" → spouse-edge.
3. RESIDENCE-ERGÄNZUNGEN. Beispiel: "lange in Lütjenburg gelebt" → neuer residences-Eintrag Lütjenburg (schl.-holst. PLZ 24321).
4. STRUKTUR-ERGÄNZUNGEN bestehender Einträge. Beispiel: residence hat place="Lütjenburg" aber keine PLZ/Stadt/Region → suggest residence_update mit postal_code=24321, city=Lütjenburg, region=Schleswig-Holstein.
5. FELD-NORMALISIERUNG. Beispiel: Datum "ca. 1920" → nicht ändern. Datum "11.3.1950" → suggest normalize auf "11.03.1950" (TT.MM.JJJJ). Ort "Berlin W35" → suggest city=Berlin, district nach Postleitgebiet mapping.
6. WIDERSPRÜCHE. Beispiel: notes sagen *1920 aber birth_date ist 1922.

Nenne NIEMALS existierende Person-IDs raten. Nutze NUR IDs aus dem Namensregister. Für neue Personen: given_name + surname zwingend, Rest optional.

Antworte AUSSCHLIESSLICH mit JSON-Objekt, kein Markdown, keine Erklärung davor/danach. Lieber leere Arrays als Vermutungen. Felder die du nicht brauchst darfst du als leeres Array lassen.

Schema:
{
  "new_persons": [
    {"given_name":"...","surname":"...","birth_name":null,"gender":"m|f|null","birth_date":null,"birth_place":null,"death_date":null,"death_place":null,"notes":null,"source_hint":"..."}
  ],
  "new_edges": [
    {"from_person_id":"<id-aus-register-oder-null-falls-this-person>","to_person_id":"<id-aus-register>","type":"parent|spouse","status":"married|divorced|widowed|engaged|partner|null","source_hint":"..."},
    {"from_person_id":"<id-aus-register>","to_hint":{"given_name":"Giesela","surname":"Sehnke"},"type":"spouse","status":"married","source_hint":"..."}
  ],
  "new_residences": [
    {"place":"Lütjenburg","street":null,"city":"Lütjenburg","district":null,"postal_code":"24321","postal_code_historical":null,"region":"Schleswig-Holstein","country":"Deutschland","start_date":null,"end_date":null,"kind":null,"notes":"aus Notes abgeleitet","source_hint":"..."}
  ],
  "residence_updates": [
    {"entry_id":"<res-id-aus-ctx>","patch":{"postal_code":"24321","city":"Lütjenburg","region":"Schleswig-Holstein"},"source_hint":"PLZ ergänzt"}
  ],
  "job_updates": [
    {"entry_id":"<job-id-aus-ctx>","patch":{"employer":"Siemens"},"source_hint":"..."}
  ],
  "field_updates": [
    {"field":"birth_date","current":"11.3.1950","suggested":"11.03.1950","reason":"Normalform TT.MM.JJJJ"}
  ],
  "contradictions": [
    {"what":"notes sagen *1920, birth_date aber 1922","confidence":"low","note":"klären"}
  ]
}

Erlaubte person-Felder für field_updates: given_name, surname, birth_name, nicknames, gender, birth_date, birth_place, death_date, death_place, notes.

Verwende null für fehlende Felder, nicht leere Strings.`;

function buildUserPrompt(ctx, register) {
  const payload = {
    person: ctx.person,
    parents: ctx.parents.map(p => ({ id: p.id, name: nm(p), birth_date: p.birth_date })),
    spouses: ctx.spouses.map(p => ({ id: p.id, name: nm(p), birth_date: p.birth_date })),
    children: ctx.children.map(p => ({ id: p.id, name: nm(p), birth_date: p.birth_date })),
    siblings: ctx.siblings.map(p => ({ id: p.id, name: nm(p), birth_date: p.birth_date })),
    jobs: ctx.jobs,
    education: ctx.education,
    residences: ctx.residences,
    anecdotes: ctx.anecdotes,
    military: ctx.military,
    health: ctx.health,
    documentCaptions: ctx.docCaptions,
    name_register: register,
  };
  return `Daten der Person und Namensregister:\n\n${JSON.stringify(payload, null, 2)}`;
}

function nm(p) {
  return [p.given_name, p.surname].filter(Boolean).join(' ') || '(ohne Namen)';
}

export async function runReview(anthropic, ctx, register) {
  const userPrompt = buildUserPrompt(ctx, register);
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = resp.content.find(b => b.type === 'text')?.text?.trim() || '';
  const data = extractJson(text);
  if (!data) {
    const err = new Error('model did not return parseable JSON');
    err.code = 'PARSE_FAILED';
    err.raw = text;
    throw err;
  }
  return { suggestions: normalise(data), model: resp.model || MODEL, usage: resp.usage };
}

function extractJson(text) {
  if (!text) return null;
  const trimmed = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* ignore */ }
  }
  return null;
}

// Garantiere alle 7 Buckets als Arrays
function normalise(d) {
  const keys = ['new_persons','new_edges','new_residences','residence_updates','job_updates','field_updates','contradictions'];
  const out = {};
  for (const k of keys) out[k] = Array.isArray(d?.[k]) ? d[k] : [];
  return out;
}
