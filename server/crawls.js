import { randomUUID } from 'node:crypto';
import robotsParser from 'robots-parser';
import { z } from 'zod';
import { externalUrl, publicFetch, badRequest } from './outbound.js';
import { renderWebsite } from './render-website.js';
import { chunks } from './knowledge.js';
import { redact } from './security.js';

export function crawlLink(href, base) {
  try {
    const url = new URL(href, base),
      root = new URL(base);
    if (
      url.origin !== root.origin ||
      /\.(pdf|png|jpe?g|webp|svg|zip|docx?|xlsx?|pptx?|mp[34]|woff2?)$/i.test(
        url.pathname,
      )
    )
      return null;
    url.hash = ''; // Fragment anchors do not represent another document.
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return externalUrl(url.href).href;
  } catch {
    return null;
  }
}

export function mountCrawls(app, { db }) {
  app.post('/api/clients/:id/crawls', async (req, res) => {
    const data = z
      .object({ url: z.string().max(2000), follow: z.boolean().default(false) })
      .parse(req.body);
    const url = externalUrl(data.url).href;
    if (!(await db.one('SELECT id FROM clients WHERE id=$1', [req.params.id])))
      return res.sendStatus(404);
    const id = randomUUID();
    const inserted = await db.one(
      "INSERT INTO crawl_runs(id,client_id,url,follow_links,queue) VALUES($1,$2,$3,$4,$5) ON CONFLICT (client_id) WHERE status='running' DO NOTHING RETURNING id",
      [id, req.params.id, url, data.follow, JSON.stringify([url])],
    );
    if (!inserted)
      throw badRequest(
        'A website crawl is already running for this client. Stop it before starting another.',
      );
    res.status(202).json({ id });
  });
  app.get('/api/clients/:id/crawls', async (req, res) =>
    res.json(
      await db.all(
        'SELECT id,url,status,completed,failed,note,jsonb_array_length(queue)::int AS remaining,created_at FROM crawl_runs WHERE client_id=$1 ORDER BY created_at DESC LIMIT 10',
        [req.params.id],
      ),
    ),
  );
  app.post('/api/clients/:id/crawls/:crawlId/:action', async (req, res) => {
    const action = z.enum(['stop', 'resume']).parse(req.params.action);
    const row = await db.one(
      "UPDATE crawl_runs SET status=$1,owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$2 AND client_id=$3 AND status<> 'completed' RETURNING id",
      [
        action === 'stop' ? 'stopped' : 'running',
        req.params.crawlId,
        req.params.id,
      ],
    );
    if (!row)
      throw badRequest('This crawl is complete or no longer available.');
    res.json({ ok: true });
  });
}

export function createCrawlWorker({
  db,
  render = renderWebsite,
  fetchFn = publicFetch,
}) {
  const owner = randomUUID();
  let timer,
    active,
    stopping = false;
  async function tick() {
    if (active || stopping) return;
    active = processPage();
    try {
      await active;
    } catch {
      /* Persisted queue is retried after the lease expires. */
    } finally {
      active = null;
    }
  }
  async function processPage() {
    const run = await db.one(
      `UPDATE crawl_runs SET owner=$1,lease_until=now()+interval '90 seconds' WHERE id=(SELECT id FROM crawl_runs WHERE status='running' AND (lease_until IS NULL OR lease_until<now()) ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      [owner],
    );
    if (!run) return;
    const queue = [...run.queue],
      visited = new Set(run.visited),
      url = queue.shift();
    if (!url) {
      await db.query(
        "UPDATE crawl_runs SET status='completed',owner=NULL,lease_until=NULL WHERE id=$1 AND owner=$2",
        [run.id, owner],
      );
      return;
    }
    let page,
      note = '',
      failed = 0;
    try {
      const robotsUrl = new URL('/robots.txt', run.url).href;
      const response = await fetchFn(robotsUrl, { limit: 200000 });
      if (!response.ok && response.status !== 404)
        throw new Error('Could not check website crawl rules.');
      const robots = robotsParser(
        robotsUrl,
        response.ok ? await response.text() : '',
      );
      if (robots.isAllowed(url, 'RelayKnowledgeBot') === false)
        throw new Error('Page excluded by website crawl rules.');
      const delay = robots.getCrawlDelay('RelayKnowledgeBot') || 0;
      if (
        delay > 0 &&
        run.completed + run.failed > 0 &&
        Date.now() < new Date(run.updated_at).getTime() + delay * 1000
      ) {
        await db.query(
          'UPDATE crawl_runs SET owner=NULL,lease_until=$1 WHERE id=$2 AND owner=$3',
          [
            new Date(new Date(run.updated_at).getTime() + delay * 1000),
            run.id,
            owner,
          ],
        );
        return;
      }
      page = await render(url);
      if (!page.text?.trim())
        throw new Error('No readable text found on this page.');
      if (page.text.length > 100000)
        note =
          'A large page was trimmed to 100,000 characters. Review that source and import any missing details separately.';
      if (run.follow_links)
        for (const link of page.links || []) {
          const next = crawlLink(link, url);
          if (
            next &&
            next !== url &&
            !visited.has(next) &&
            !queue.includes(next)
          )
            queue.push(next);
        }
    } catch (error) {
      failed = 1;
      note = `${url}: ${/^Website returned HTTP|^Page excluded|^Could not check|^No readable/.test(error.message) ? error.message : 'Page could not be read. Retry the page separately or import its text.'}`;
    }
    visited.add(url);
    // Frontier update and source insert commit together. A lost lease or stopped crawl
    // cannot write results; a restarted worker processes the persisted page again.
    const content = page ? redact(page.text.slice(0, 100000)) : '';
    await db.query(
      `WITH updated AS (
      UPDATE crawl_runs SET queue=$1,visited=$2,completed=completed+$3,failed=failed+$4,note=CASE WHEN $5='' THEN note ELSE $5 END,status=$6,owner=NULL,lease_until=NULL,updated_at=now()
      WHERE id=$7 AND owner=$8 AND status='running' AND lease_until>now() RETURNING client_id
    ), source AS (
      INSERT INTO knowledge_sources(id,client_id,title,origin,content,approved)
      SELECT $9,client_id,$10,$11,$12,false FROM updated WHERE $12<>'' RETURNING id
    ) INSERT INTO knowledge_chunks(source_id,ordinal,content)
    SELECT source.id,(part.ordinality-1)::int,part.value FROM source,jsonb_array_elements_text($13::jsonb) WITH ORDINALITY AS part(value,ordinality)`,
      [
        JSON.stringify(queue),
        JSON.stringify([...visited]),
        page ? 1 : 0,
        failed,
        note,
        queue.length ? 'running' : 'completed',
        run.id,
        owner,
        randomUUID(),
        page?.title || url,
        url,
        content,
        JSON.stringify(chunks(content)),
      ],
    );
  }
  return {
    tick,
    start() {
      timer = setInterval(() => void tick(), 1500);
      void tick();
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      await active;
    },
  };
}
