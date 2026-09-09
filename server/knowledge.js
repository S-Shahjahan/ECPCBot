import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { load } from 'cheerio';
import robotsParser from 'robots-parser';
import { badRequest, externalUrl, publicFetch } from './outbound.js';
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

export async function crawlWebsite(input, maxPages = 1, fetchFn = publicFetch) {
  const initial = externalUrl(input);
  initial.hash = '';
  const robotsUrl = initial.origin + '/robots.txt';
  const robotsResponse = await fetchFn(robotsUrl, { limit: 200000 });
  if (!robotsResponse.ok && robotsResponse.status !== 404)
    throw badRequest(
      'Could not check this website’s crawl rules. Import its text directly instead.',
    );
  const robots = robotsParser(
    robotsUrl,
    robotsResponse.ok ? await robotsResponse.text() : '',
  );
  const queue = [initial.href],
    seen = new Set(),
    pages = [],
    warnings = [];
  const started = Date.now();
  while (
    queue.length &&
    pages.length < maxPages &&
    seen.size < 24 &&
    Date.now() - started < 90000
  ) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    if (robots.isAllowed(url, 'RelayKnowledgeBot') === false) {
      warnings.push(
        'A page was skipped because its crawl rules disallow access.',
      );
      continue;
    }
    const delay = robots.getCrawlDelay('RelayKnowledgeBot') || 0;
    if (delay > 10) {
      warnings.push(
        'This website requires a long crawl delay. Import its text directly.',
      );
      break;
    }
    if (delay) await new Promise((r) => setTimeout(r, delay * 1000));
    let response;
    try {
      response = await fetchFn(url, {
        limit: 1000000,
        headers: {
          'User-Agent': 'RelayKnowledgeBot/1.0',
          Accept: 'text/html,text/plain',
        },
      });
    } catch {
      warnings.push('A page could not be reached and was skipped.');
      continue;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const redirect = externalUrl(
        new URL(response.headers.get('location'), url).href,
      );
      if (redirect.origin === initial.origin) queue.unshift(redirect.href);
      else
        warnings.push(
          'An external redirect was skipped. Import the final website URL separately.',
        );
      continue;
    }
    if (!response.ok) {
      warnings.push(`A page returned HTTP ${response.status}.`);
      continue;
    }
    const type = response.headers.get('content-type') || '';
    if (!/text\/(html|plain)/i.test(type)) {
      warnings.push('A non-text page was skipped.');
      continue;
    }
    const html = await response.text();
    const $ = load(html);
    const links = $('a[href]')
      .map((_i, el) => $(el).attr('href'))
      .get();
    $(
      'script,style,nav,footer,header,noscript,iframe,form,[hidden],[aria-hidden="true"]',
    ).remove();
    $('p,div,section,li,br,h1,h2,h3,tr').append('\n');
    const content = (/text\/plain/.test(type) ? html : $('body').text())
      .replace(/[\t ]+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();
    if (content)
      pages.push({
        url,
        title: $('title').text().trim().slice(0, 200) || url,
        text: redact(content.slice(0, 60000)),
      });
    for (const href of links) {
      try {
        const next = new URL(href, url);
        next.hash = '';
        if (
          next.origin === initial.origin &&
          !next.search &&
          !/\.(pdf|png|jpg|zip|docx?|mp4)$/i.test(next.pathname) &&
          queue.length < 50
        )
          queue.push(next.href);
      } catch {
        /* Ignore non-URL links. */
      }
    }
  }
  if (!pages.length)
    throw badRequest(
      'No readable public pages were found. Try the final page URL or paste text directly.',
    );
  return {
    text: pages
      .map((p) => `SOURCE: ${p.url}\n${p.title}\n${p.text}`)
      .join('\n\n')
      .slice(0, 100000),
    pages: pages.map(({ url, title }) => ({ url, title })),
    note: [
      ...new Set(warnings),
      'Static public pages only. Review for accuracy; content is not automatically refreshed.',
    ].join(' '),
  };
}
export function chunks(text) {
  const result = [];
  for (let i = 0; i < text.length; i += 1600)
    result.push(text.slice(i, i + 1900));
  return result;
}
export async function saveSource(db, clientId, input) {
  const id = randomUUID();
  const count = await db.one(
    'SELECT count(*)::int AS n, coalesce(sum(length(content)),0)::int AS size FROM knowledge_sources WHERE client_id=$1',
    [clientId],
  );
  if (count.n >= 100 || count.size + input.content.length > 1000000)
    throw badRequest(
      'Library limit reached (100 sources / 1 million characters). Remove older sources first.',
    );
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
  const terms = question.match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 30) || [];
  const query = terms.map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).join(' | ');
  const rows = await db.all(
    `SELECT s.title,k.content FROM knowledge_chunks k JOIN knowledge_sources s ON s.id=k.source_id WHERE s.client_id=$1 AND s.approved ORDER BY ts_rank(k.search,to_tsquery('simple',$2)) DESC,s.created_at DESC,k.ordinal LIMIT 10`,
    [clientId, query || 'relaynomatch'],
  );
  return rows.map((r) => `${r.title}\n${r.content}`).join('\n\n');
}
