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
export async function retrieveKnowledge(db, clientId, question) {
  const terms = question.match(/[\p{L}\p{N}]{2,}/gu)?.slice(-80) || [];
  const query = terms.map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).join(' | ');
  const rows = await db.all(
    `SELECT s.title,k.content FROM knowledge_chunks k JOIN knowledge_sources s ON s.id=k.source_id WHERE s.client_id=$1 AND s.approved ORDER BY ts_rank(k.search,to_tsquery('simple',$2)) DESC,s.created_at DESC,k.ordinal LIMIT 10`,
    [clientId, query || 'relaynomatch'],
  );
  return rows.map((r) => `${r.title}\n${r.content}`).join('\n\n');
}
