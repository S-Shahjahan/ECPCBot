import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { badRequest } from './outbound.js';
import { redact } from './security.js';

let extracting = false;
export async function extractFile(file) {
  if (!file) throw badRequest('Choose a file to import.');
  if (extracting)
    throw Object.assign(
      new Error('Another import is processing. Try again shortly.'),
      { status: 429 },
    );
  extracting = true;
  try {
    return await new Promise((resolve, reject) => {
      const child = fork(new URL('./extract-file.js', import.meta.url), [], {
        execArgv: ['--max-old-space-size=256'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(badRequest('Import exceeded 90 seconds. Use a smaller file.'));
      }, 90000);
      child.once('message', (result) => {
        clearTimeout(timer);
        child.kill();
        result.error
          ? reject(badRequest(result.error))
          : resolve({ ...result, text: redact(result.text) });
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(badRequest('The file reader could not start.'));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code)
          reject(
            badRequest(
              'The file is too complex to process. Try a smaller file.',
            ),
          );
      });
      child.send({
        base64: file.buffer.toString('base64'),
        name: file.originalname,
      });
    });
  } finally {
    extracting = false;
  }
}

export function chunks(text) {
  const result = [];
  for (let i = 0; i < text.length; i += 1600)
    result.push(text.slice(i, i + 1900));
  return result;
}

export const KNOWLEDGE_CHAR_BUDGET = 3500;
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'do',
  'for',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'the',
  'this',
  'to',
  'we',
  'what',
  'when',
  'where',
  'which',
  'with',
  'you',
  'your',
]);
const SYNONYMS = {
  offer: ['service', 'services', 'product', 'products'],
  available: ['availability', 'service', 'services', 'product', 'products'],
  cost: ['price', 'pricing', 'rate'],
  rate: ['price', 'pricing', 'cost'],
  timing: ['hours', 'open', 'opening'],
  timings: ['hours', 'open', 'opening'],
  address: ['location', 'located'],
  location: ['address', 'located'],
  mail: ['email'],
};

export function searchTerms(question, limit = 24) {
  const original = question.match(/[\p{L}\p{N}]{2,}/gu) || [];
  const terms = [];
  for (const raw of original) {
    const term = raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!term || STOP_WORDS.has(term)) continue;
    for (const value of [term, ...(SYNONYMS[term] || [])])
      if (!terms.includes(value)) terms.push(value);
    if (terms.length >= limit) break;
  }
  return terms.slice(0, limit);
}

export function relevantText(text, question, maxChars = 1500) {
  const value = String(text || '').trim();
  if (value.length <= maxChars) return value;
  const terms = searchTerms(question);
  const passages = value
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((content, index) => ({ content: content.trim(), index }))
    .filter((part) => part.content);
  for (const part of passages) {
    const normalized = part.content.toLowerCase();
    part.score = terms.reduce(
      (score, term) => score + (normalized.includes(term) ? 1 : 0),
      0,
    );
  }
  const ranked = passages
    .filter((part) => part.score)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [];
  let used = 0;
  for (const part of ranked.length ? ranked : passages) {
    const remaining = maxChars - used - (selected.length ? 2 : 0);
    if (remaining <= 0) break;
    selected.push({ ...part, content: part.content.slice(0, remaining) });
    used +=
      Math.min(part.content.length, remaining) + (selected.length > 1 ? 2 : 0);
  }
  return selected
    .sort((a, b) => a.index - b.index)
    .map((part) => part.content)
    .join('\n\n');
}
export async function saveSource(db, clientId, input) {
  const id = randomUUID();
  const content = redact(input.content);
  await db.query(
    `WITH source AS (INSERT INTO knowledge_sources(id,client_id,title,origin,content,approved) VALUES($1,$2,$3,$4,$5,$6) RETURNING id)
    INSERT INTO knowledge_chunks(source_id,ordinal,content) SELECT source.id, (part.ordinality-1)::int,part.value FROM source,jsonb_array_elements_text($7::jsonb) WITH ORDINALITY AS part(value,ordinality)`,
    [
      id,
      clientId,
      input.title,
      input.origin || '',
      content,
      input.approved,
      JSON.stringify(chunks(content)),
    ],
  );
  return { id };
}
export async function retrieveKnowledge(
  db,
  clientId,
  question,
  maxChars = KNOWLEDGE_CHAR_BUDGET,
) {
  const terms = searchTerms(question);
  if (!terms.length) return '';
  const query = terms.join(' | ');
  const rows = await db.all(
    `WITH q AS (SELECT to_tsquery('simple',$2) AS terms)
     SELECT s.title,k.content,
       ts_rank_cd(k.search,q.terms) AS rank
     FROM knowledge_chunks k
     JOIN knowledge_sources s ON s.id=k.source_id
     CROSS JOIN q
     WHERE s.client_id=$1 AND s.approved
       AND k.search @@ q.terms
     ORDER BY rank DESC,s.created_at DESC,k.ordinal
     LIMIT 8`,
    [clientId, query],
  );
  const selected = [];
  let used = 0;
  for (const row of rows) {
    const prefix = `SOURCE: ${String(row.title).slice(0, 200)}\n`;
    const remaining = maxChars - used - (selected.length ? 2 : 0);
    if (remaining <= prefix.length) break;
    const passage = prefix + row.content.slice(0, remaining - prefix.length);
    selected.push(passage);
    used += passage.length + (selected.length > 1 ? 2 : 0);
    if (used >= maxChars) break;
  }
  return selected.join('\n\n');
}
