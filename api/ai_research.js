// KI-Vollrecherche: orchestrates research-hit driven Pass-2 (and optional
// Pass-3) Claude analysis.  Separate from ai_review.js — different prompt,
// different model config, source provenance tracking.

import { createHash } from 'node:crypto';
import { fetchPage } from './scrape_fetcher.js';
import { runSingleSource } from './research_dispatch.js';

export const MODEL =
  process.env.ANTHROPIC_AI_RESEARCH_MODEL ||
  process.env.ANTHROPIC_AI_REVIEW_MODEL ||
  'claude-opus-4-7';

const SNIPPET_MAX = 400;
const MAX_HITS = 60;
const DEEP_DIVE_SNIPPET_MAX = 600;

// Host-based whitelist from pass-2 hits; reject private/reserved IPs (string-level, no DNS).
const PRIVATE_IP_RE = new RegExp(
  '^localhost$' +
  '|^0\\.' +
  '|^127\\.' +
  '|^10\\.' +
  '|^172\\.(1[6-9]|2\\d|3[01])\\.' +
  '|^192\\.168\\.' +
  '|^169\\.254\\.' +
  '|^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.' +   // CGNAT 100.64.0.0/10
  '|^::1$' +
  '|^\\[::1\\]$' +
  '|^fe80::' +
  '|^fc[0-9a-f]{2}:' +
  '|^fd[0-9a-f]{2}:' +
  '|^::ffff:(10\\.|127\\.|169\\.254\\.|172\\.(1[6-9]|2\\d|3[01])\\.|192\\.168\\.)',
  'i'
);

const SYSTEM_PROMPT = `Du bist Dossier-Analyst für eine private Familien-Archiv-Anwendung. Du erhältst (a) biographische Daten einer Person, (b) ein Namensregister aller anderen erfassten Personen, (c) Recherche-Treffer aus externen Quellen (Snippets/Volltexte).

Analysiere ALLE Treffer gründlich und schlage neue strukturierte Einträge vor. Jeder Vorschlag braucht eine \`source_url\` (URL der Quelle) und ein \`source_quote\` (wörtliches Zitat, max 160 Zeichen, das den Vorschlag belegt).

Schema (JSON-Objekt, kein Markdown davor/danach):
{
  "new_persons": [{"given_name":"...","surname":"...","birth_name":null,"gender":null,"birth_date":null,"birth_place":null,"death_date":null,"death_place":null,"notes":null,"source_url":"...","source_quote":"...","source_hint":"..."}],
  "new_edges": [{"from_person_id":"<id-oder-'this'>","to_person_id":"<id>","type":"parent|spouse","status":null,"source_url":"...","source_quote":"...","source_hint":"..."}],
  "new_residences": [{"place":"...","street":null,"city":"...","district":null,"postal_code":null,"postal_code_historical":null,"region":null,"country":"Deutschland","start_date":null,"end_date":null,"kind":null,"notes":null,"source_url":"...","source_quote":"...","source_hint":"..."}],
  "residence_updates": [{"entry_id":"...","patch":{},"source_url":"...","source_quote":"...","source_hint":"..."}],
  "job_updates": [{"entry_id":"...","patch":{},"source_url":"...","source_quote":"...","source_hint":"..."}],
  "new_jobs": [{"title":"...","employer":"...","place":null,"start_date":null,"end_date":null,"notes":null,"source_url":"...","source_quote":"...","source_hint":"..."}],
  "new_education": [{"institution":"...","field":null,"degree":null,"place":null,"start_date":null,"end_date":null,"notes":null,"source_url":"...","source_quote":"...","source_hint":"..."}],
  "new_anecdotes": [{"title":"...","text":"...","year":null,"source":null,"source_url":"...","source_quote":"..."}],
  "field_updates": [{"field":"...","current":null,"suggested":"...","reason":"...","source_url":"...","source_quote":"...","conflicts_field":null,"conflicts_value":null}],
  "contradictions": [{"what":"...","confidence":"low|medium|high","note":null,"source_url":null,"source_quote":null}],
  "follow_ups": [{"action":"fetch_url","url":"...","reason":"..."}]
}

Erlaubte Aktionen in follow_ups: fetch_url (url, reason), refine_source_query (source_key, query, reason).
Richtungskonvention parent-edge: from = Elternteil, to = Kind. IMMER.
Verwende null für fehlende Felder. Antworte AUSSCHLIESSLICH mit JSON.`;

export function buildPass2Prompt(bioContext, nameRegister, hits, yearSpan, gaps) {
  const payload = {
    person: bioContext.person,
    parents: (bioContext.parents || []).map(p => ({ id: p.id, name: [p.given_name, p.surname].filter(Boolean).join(' '), birth_date: p.birth_date })),
    spouses: (bioContext.spouses || []).map(p => ({ id: p.id, name: [p.given_name, p.surname].filter(Boolean).join(' '), birth_date: p.birth_date })),
    children: (bioContext.children || []).map(p => ({ id: p.id, name: [p.given_name, p.surname].filter(Boolean).join(' '), birth_date: p.birth_date })),
    jobs: bioContext.jobs || [],
    education: bioContext.education || [],
    residences: bioContext.residences || [],
    anecdotes: bioContext.anecdotes || [],
    military: bioContext.military || [],
    name_register: nameRegister,
  };

  let user = `Daten der Person:\n\n${JSON.stringify(payload, null, 2)}`;

  if (yearSpan) {
    user += `\n\nRecherchezeit-Raum: ${yearSpan.from}–${yearSpan.to}`;
  }

  if (gaps && gaps.length) {
    user += `\n\nFehlende Felder (besonders auf diese achten): ${gaps.join(', ')}`;
  }

  if (hits && hits.length) {
    user += `\n\n=== RECHERCHE-TREFFER (${hits.length} Einträge) ===\n`;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const snippet = (h.snippet || '').slice(0, SNIPPET_MAX);
      user += `\n[R${i + 1}] Quelle: ${h.source} | Confidence: ${(h.confidence || 0).toFixed(2)}\nTitel: ${h.title || '(ohne Titel)'}\nURL: ${h.url || ''}\nSnippet: ${snippet}\n`;
    }
  }

  user += `\n\nGib JSON-Vorschläge zurück (Schema wie vorgegeben). Für follow_ups: nur wenn ein Volltext-Abruf tatsächlich neue Fakten liefern würde.`;

  return { system: SYSTEM_PROMPT, user };
}

export function buildPass3Prompt(previousSuggestions, deepDiveSnippets, prevUserPrompt) {
  let user = prevUserPrompt + '\n\n## Deep-dive results\n\n';
  for (let i = 0; i < deepDiveSnippets.length; i++) {
    const d = deepDiveSnippets[i];
    const snippet = (d.snippet || d.text || '').slice(0, DEEP_DIVE_SNIPPET_MAX);
    user += `[D${i + 1}] ${d.url || ''} / ${d.title || '(kein Titel)'}\n${snippet}\n\n`;
  }
  user += `Integriere die Deep-dive Ergebnisse. Ersetze die vorige Antwort durch ein komplett neues JSON-Objekt. Keine follow_ups im Ergebnis.`;
  return { system: SYSTEM_PROMPT, user };
}

export function parseAndValidateSuggestions(rawText) {
  if (!rawText) throw new Error('empty response from model');
  const trimmed = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { data = JSON.parse(trimmed.slice(first, last + 1)); } catch { /* fall through */ }
    }
  }
  if (!data) return null;

  const ALLOWED_BUCKETS = [
    'new_persons', 'new_edges', 'new_residences', 'residence_updates',
    'job_updates', 'new_jobs', 'new_education', 'new_anecdotes',
    'field_updates', 'contradictions', 'follow_ups',
  ];
  const out = {};
  for (const k of ALLOWED_BUCKETS) {
    out[k] = Array.isArray(data[k]) ? data[k] : [];
  }

  // Enforce source_url + source_quote on non-contradiction items
  for (const k of ALLOWED_BUCKETS) {
    if (k === 'contradictions' || k === 'follow_ups') continue;
    out[k] = out[k].map(item => ({
      source_url: null,
      source_quote: null,
      ...item,
    }));
  }

  return out;
}

export function hashResearchContext(person, hitDigests, yearSpan) {
  const canonical = JSON.stringify({
    _v: 'research-v1',
    id: person.id,
    given_name: person.given_name,
    surname: person.surname,
    birth_date: person.birth_date,
    death_date: person.death_date,
    hitDigests: (hitDigests || []).slice().sort(),
    yearSpan: yearSpan || null,
  });
  return 'research:' + createHash('sha256').update(canonical).digest('hex');
}

function truncateHits(hits) {
  if (!hits || !hits.length) return { hits: [], dropped: 0 };

  // Sort: top confidence first, then by source for diversity
  const sorted = [...hits].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  // Cap snippets
  const capped = sorted.map(h => ({
    ...h,
    snippet: (h.snippet || '').slice(0, SNIPPET_MAX),
  }));

  const dropped = Math.max(0, capped.length - MAX_HITS);
  return { hits: capped.slice(0, MAX_HITS), dropped };
}

async function callModel(anthropic, system, user) {
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = resp.content.find(b => b.type === 'text')?.text?.trim() || '';
  return { text, usage: resp.usage, model: resp.model || MODEL };
}

async function callModelWithRetry(anthropic, system, user) {
  const first = await callModel(anthropic, system, user);
  const data = parseAndValidateSuggestions(first.text);
  if (data) return { data, usage: first.usage, model: first.model };

  // One retry on parse failure
  const retryUser = user + '\n\nYou returned invalid JSON. Return ONLY valid JSON, no prose or markdown.';
  const second = await callModel(anthropic, system, retryUser);
  const data2 = parseAndValidateSuggestions(second.text);
  if (!data2) {
    const err = new Error('model did not return parseable JSON after retry');
    err.code = 'PARSE_FAILED';
    err.raw = second.text;
    throw err;
  }
  return { data: data2, usage: second.usage, model: second.model };
}

async function fetchDeepDive(url, allowedHosts) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (PRIVATE_IP_RE.test(host)) return null;
    // Reject non-standard ports (only 80/443 and implicit default allowed)
    if (u.port && u.port !== '80' && u.port !== '443') return null;
    // Empty allowedHosts means no external fetching is permitted
    if (!allowedHosts.has(host)) return null;
    const result = await fetchPage('deep_dive', url, { timeoutMs: 15000 });
    if (!result.ok) return null;
    const text = result.markdown || result.text || result.html || '';
    return { url, title: result.title || '', text: text.slice(0, DEEP_DIVE_SNIPPET_MAX) };
  } catch {
    return null;
  }
}

async function processFollowUp(fu, allowedHosts, person) {
  if (!fu || !fu.action) return null;
  if (fu.action === 'fetch_url') {
    return fetchDeepDive(fu.url, allowedHosts);
  }
  if (fu.action === 'refine_source_query') {
    if (!fu.source_key || !fu.query) return null;
    try {
      const personWithOverride = { ...person, _overrideQuery: fu.query };
      const r = await runSingleSource(fu.source_key, personWithOverride, { useCache: false });
      if (!r.hits.length) return null;
      const h = r.hits[0];
      return {
        url: h.url || '',
        title: h.title || '',
        text: (h.snippet || '').slice(0, DEEP_DIVE_SNIPPET_MAX),
      };
    } catch {
      return null;
    }
  }
  return null;
}

export async function runAiResearch(anthropic, person, bioContext, nameRegister, rawHits, opts = {}) {
  const yearSpan = opts.yearSpan || null;
  const gaps = opts.gaps || [];
  const budget = {
    max_llm_calls: Math.min(2, Math.max(1, opts.budget?.max_llm_calls ?? 1)),
    max_fetches: Math.min(3, Math.max(0, opts.budget?.max_fetches ?? 0)),
  };

  const { hits, dropped } = truncateHits(rawHits);
  const hitDigests = hits.map(h => h.url || h.title || '').filter(Boolean);

  const sources_summary = {
    total_hits: rawHits ? rawHits.length : 0,
    used_hits: hits.length,
    dropped_hits: dropped,
  };

  const { system, user: pass2User } = buildPass2Prompt(bioContext, nameRegister, hits, yearSpan, gaps);
  const pass2 = await callModelWithRetry(anthropic, system, pass2User);

  let suggestions = pass2.data;
  let usage = pass2.usage;
  let modelName = pass2.model;
  let follow_ups_consumed = 0;

  // Pass-3: only if budget allows and there are follow_ups
  if (budget.max_llm_calls >= 2 && suggestions.follow_ups.length > 0) {
    const allowedHosts = new Set(
      hits
        .map(h => { try { return new URL(h.url || '').hostname; } catch { return null; } })
        .filter(Boolean)
    );

    const toFetch = suggestions.follow_ups.slice(0, Math.min(budget.max_fetches, suggestions.follow_ups.length));
    follow_ups_consumed = toFetch.length;

    const deepResults = (await Promise.all(
      toFetch.map(fu => processFollowUp(fu, allowedHosts, person))
    )).filter(Boolean);

    if (deepResults.length > 0) {
      const { system: sys3, user: user3 } = buildPass3Prompt(suggestions, deepResults, pass2User);
      const pass3 = await callModelWithRetry(anthropic, sys3, user3);
      // Discard further follow_ups from pass-3
      pass3.data.follow_ups = [];
      suggestions = pass3.data;
      if (pass3.model) modelName = pass3.model;
      if (pass3.usage && usage) {
        usage = {
          input_tokens: (usage.input_tokens || 0) + (pass3.usage.input_tokens || 0),
          output_tokens: (usage.output_tokens || 0) + (pass3.usage.output_tokens || 0),
        };
      }
    }
  }

  // Strip follow_ups from final output
  suggestions.follow_ups = [];

  const context_hash = hashResearchContext(person, hitDigests, yearSpan);

  return { suggestions, sources_summary, usage, model: modelName, follow_ups_consumed, context_hash };
}
