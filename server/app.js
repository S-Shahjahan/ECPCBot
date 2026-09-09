import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { secretBox, passwordVerifier, safeEqual, redact } from './security.js';
import { mountWebhook } from './webhook.js';
import { publicClient, saveClient } from './clients.js';
import { providers } from './prompts.js';
import { generateReply, ProviderError } from './providers.js';
import { mountEnhancements } from './enhancements.js';
import { retrieveKnowledge } from './knowledge.js';
import { actionInstructions, actionTools } from './google.js';
class DatabaseSessions extends session.Store {
  constructor(db) {
    super();
    this.db = db;
  }
  get(sid, cb) {
    this.db
      .one('SELECT data FROM sessions WHERE sid=$1 AND expires_at>now()', [sid])
      .then((r) => cb(null, r?.data || null), cb);
  }
  set(sid, data, cb) {
    this.db
      .query(
        'INSERT INTO sessions(sid,data,expires_at) VALUES($1,$2,$3) ON CONFLICT(sid) DO UPDATE SET data=$2,expires_at=$3',
        [
          sid,
          JSON.stringify(data),
          new Date(data.cookie.expires || Date.now() + 28800000),
        ],
      )
      .then(() => cb?.(), cb);
  }
  destroy(sid, cb) {
    this.db
      .query('DELETE FROM sessions WHERE sid=$1', [sid])
      .then(() => cb?.(), cb);
  }
  touch(sid, data, cb) {
    this.db
      .query('UPDATE sessions SET expires_at=$1 WHERE sid=$2', [
        new Date(data.cookie.expires),
        sid,
      ])
      .then(() => cb?.(), cb);
  }
}
export function createApp({ db, config, generate = generateReply }) {
  const app = express();
  const box = secretBox(config.encryptionKey);
  const verifyPassword = passwordVerifier(config.password);
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          upgradeInsecureRequests: config.production ? [] : null,
        },
      },
      strictTransportSecurity: config.production ? undefined : false,
    }),
  );
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Request-ID', req.requestId);
    if (
      config.production &&
      !req.secure &&
      !['/healthz', '/readyz'].includes(req.path)
    )
      return res.status(400).json({ error: 'HTTPS is required.' });
    next();
  });
  app.get('/healthz', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  app.get('/readyz', async (_req, res) => {
    try {
      const worker = await db.one(
        'SELECT expires_at>now() AND owner IS NOT NULL AS healthy FROM worker_lock WHERE id=1',
      );
      res
        .status(worker?.healthy ? 200 : 503)
        .json({ status: worker?.healthy ? 'ready' : 'worker_unavailable' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  app.use('/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
  mountWebhook(app, { db, config, box });
  app.use('/api', express.json({ limit: '512kb' }));
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(
    '/api',
    session({
      name: 'relay.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      store: new DatabaseSessions(db),
      cookie: {
        httpOnly: true,
        secure: config.production,
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000,
      },
    }),
  );
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (
      req.get('origin') &&
      req.get('origin') !== new URL(config.appUrl).origin
    )
      return res.status(403).json({ error: 'Request origin is not allowed.' });
    if (
      !safeEqual(req.get('x-csrf-token'), req.session.csrf) ||
      !req.session.csrf
    )
      return res
        .status(403)
        .json({ error: 'Your session expired. Refresh and try again.' });
    next();
  });
  app.get('/api/session', (req, res) => {
    req.session.csrf ||= randomBytes(24).toString('hex');
    res.json({
      authenticated: Boolean(req.session.admin),
      csrf: req.session.csrf,
      demo: config.demo,
    });
  });
  app.post(
    '/api/login',
    rateLimit({
      windowMs: 900000,
      limit: 15,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many login attempts. Try again in 15 minutes.' },
    }),
    async (req, res, next) => {
      const ip = box.phoneHash(req.ip || 'unknown');
      const count = await db.one(
        `INSERT INTO login_attempts(ip_hash,count,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(ip_hash) DO UPDATE SET count=CASE WHEN login_attempts.expires_at<now() THEN 1 ELSE login_attempts.count+1 END,expires_at=CASE WHEN login_attempts.expires_at<now() THEN now()+interval '15 minutes' ELSE login_attempts.expires_at END RETURNING count`,
        [ip],
      );
      if (count.count > 10)
        return res
          .status(429)
          .json({ error: 'Too many login attempts. Try again in 15 minutes.' });
      if (!config.demo && !verifyPassword(req.body.password))
        return res.status(401).json({ error: 'The password is incorrect.' });
      req.session.regenerate((error) => {
        if (error) return next(error);
        req.session.admin = true;
        req.session.csrf = randomBytes(24).toString('hex');
        req.session.save((error) =>
          error
            ? next(error)
            : res.json({
                authenticated: true,
                csrf: req.session.csrf,
                demo: config.demo,
              }),
        );
      });
    },
  );
  app.use('/api', (req, res, next) =>
    req.session.admin
      ? next()
      : res.status(401).json({ error: 'Please sign in.' }),
  );
  app.post('/api/logout', (req, res, next) =>
    req.session.destroy((error) =>
      error ? next(error) : res.clearCookie('relay.sid').json({ ok: true }),
    ),
  );
  app.get('/api/overview', async (_req, res) => {
    const counts = await db.one(
      `SELECT (SELECT count(*)::int FROM clients) AS clients,(SELECT count(*)::int FROM clients WHERE is_active) AS active,(SELECT count(*)::int FROM conversations WHERE last_user_at>now()-interval '24 hours') AS conversations,(SELECT count(*)::int FROM alerts WHERE resolved=false) AS attention,(SELECT coalesce(sum(cost),0) FROM llm_usage WHERE created_at>=date_trunc('month',now())) AS cost,(SELECT coalesce(sum(tokens),0) FROM llm_usage WHERE created_at>=date_trunc('month',now())) AS tokens,(SELECT count(*)::int FROM jobs WHERE state='pending') AS queued`,
    );
    const activity = await db.all(
      `SELECT date_trunc('day',created_at) AS day,count(*)::int AS messages FROM message_logs WHERE created_at>now()-interval '7 days' GROUP BY 1 ORDER BY 1`,
    );
    res.json({ ...counts, activity });
  });
  app.get('/api/clients', async (_req, res) => {
    const rows = await db.all(
      `SELECT c.*,(SELECT count(*)::int FROM conversations cv WHERE cv.client_id=c.id) AS conversation_count,(SELECT count(*)::int FROM conversations cv WHERE cv.client_id=c.id AND cv.status='human') AS handoff_count,(SELECT coalesce(sum(m.cost),0) FROM llm_usage m WHERE m.client_id=c.id AND m.created_at>=date_trunc('month',now())) AS monthly_cost FROM clients c ORDER BY created_at DESC`,
    );
    res.json(rows.map(publicClient));
  });
  app.get('/api/clients/:id', async (req, res) => {
    const row = await db.one('SELECT * FROM clients WHERE id=$1', [
      req.params.id,
    ]);
    if (!row) return res.status(404).json({ error: 'Client not found.' });
    res.json(publicClient(row));
  });
  app.post('/api/clients', async (req, res) =>
    res.status(201).json(await saveClient(db, box, req.body, null, config)),
  );
  app.put('/api/clients/:id', async (req, res) =>
    res.json(await saveClient(db, box, req.body, req.params.id, config)),
  );
  app.patch('/api/clients/:id/status', async (req, res) => {
    const row = await db.one('SELECT * FROM clients WHERE id=$1', [
      req.params.id,
    ]);
    if (!row) return res.status(404).json({ error: 'Client not found.' });
    const active = z.boolean().parse(req.body.is_active);
    if (
      active &&
      !config.demo &&
      (!row.secrets.whatsapp_access_token ||
        !row.secrets.llm_api_key ||
        !(row.secrets.meta_app_secret || config.metaSecret))
    )
      return res.status(400).json({
        error:
          'Complete the credentials in this client’s settings before activating.',
      });
    await db.query(
      'UPDATE clients SET is_active=$1,updated_at=now() WHERE id=$2',
      [active, row.id],
    );
    res.json({ ok: true });
  });
  app.delete('/api/clients/:id', async (req, res) => {
    const client = await db.one('SELECT client_name FROM clients WHERE id=$1', [
      req.params.id,
    ]);
    if (!client) return res.sendStatus(404);
    if (req.body.confirm !== client.client_name)
      return res
        .status(400)
        .json({ error: 'Enter the client name to confirm deletion.' });
    await db.query('DELETE FROM clients WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  });
  app.get('/api/clients/:id/history', async (req, res) =>
    res.json(
      await db.all(
        'SELECT * FROM prompt_history WHERE client_id=$1 ORDER BY created_at DESC LIMIT 50',
        [req.params.id],
      ),
    ),
  );
  app.post(
    '/api/clients/:id/test',
    rateLimit({
      windowMs: 60000,
      limit: 10,
      message: { error: 'Please wait a minute before testing again.' },
    }),
    async (req, res) => {
      const client = await db.one('SELECT * FROM clients WHERE id=$1', [
        req.params.id,
      ]);
      if (!client) return res.sendStatus(404);
      const message = z.string().min(1).max(5000).parse(req.body.message);
      const history = z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string().min(1).max(5000),
          }),
        )
        .max(100)
        .default([])
        .parse(req.body.history);
      if (history.reduce((n, m) => n + m.content.length, 0) > 100000)
        return res
          .status(400)
          .json({ error: 'Start a new test conversation to continue.' });
      const master = await db.one(
        "SELECT value FROM settings WHERE id='master_prompt'",
      );
      const result = await generate({
        client,
        box,
        masterPrompt: master.value.text,
        knowledge: await retrieveKnowledge(
          db,
          client.id,
          [
            ...history
              .filter((m) => m.role === 'user')
              .slice(-5)
              .map((m) => m.content),
            message,
          ].join(' '),
        ),
        actionGuide: await actionInstructions(db, client.id),
        actionTools: await actionTools(db, client.id),
        messages: [...history, { role: 'user', content: message }],
        demo: config.demo,
      });
      if (result.proposedAction)
        result.text =
          'Test preview: ' +
          (result.proposedAction.name === 'prepare_email'
            ? 'prepare an email to '
            : 'prepare a call for ') +
          (result.proposedAction.arguments?.email || 'the customer') +
          (result.proposedAction.arguments?.start
            ? ' at ' + result.proposedAction.arguments.start
            : '') +
          '. In WhatsApp, the customer will be asked to confirm before any action. This test does not send mail or create events.';
      await db.query(
        'INSERT INTO llm_usage(id,client_id,source,tokens,cost) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), client.id, 'sandbox', result.tokens, result.cost],
      );
      res.json({
        ...result,
        needsHuman: result.text.includes('[NEEDS_HUMAN]'),
        text: result.text.replaceAll('[NEEDS_HUMAN]', '').trim(),
        demo: config.demo,
      });
    },
  );
  app.get('/api/conversations', async (req, res) => {
    const page = Math.max(0, Math.min(10000, Number(req.query.page) || 0));
    res.json(
      await db.all(
        `SELECT cv.id,cv.client_id,cv.phone_label,cv.status,cv.last_user_at,cv.created_at,c.client_name,(SELECT body FROM message_logs WHERE conversation_id=cv.id ORDER BY created_at DESC LIMIT 1) AS last_message FROM conversations cv JOIN clients c ON c.id=cv.client_id WHERE ($1='' OR cv.client_id=$1) AND ($2='' OR cv.status=$2) ORDER BY cv.last_user_at DESC LIMIT 31 OFFSET $3`,
        [
          String(req.query.client || ''),
          req.query.status === 'human' ? 'human' : '',
          page * 30,
        ],
      ),
    );
  });
  app.get('/api/conversations/:id', async (req, res) => {
    const conversation = await db.one(
      'SELECT cv.*,c.client_name FROM conversations cv JOIN clients c ON c.id=cv.client_id WHERE cv.id=$1',
      [req.params.id],
    );
    if (!conversation) return res.sendStatus(404);
    const messages = await db.all(
      'SELECT * FROM message_logs WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200',
      [conversation.id],
    );
    const jobs = await db.all(
      "SELECT id,state,attempts,updated_at FROM jobs WHERE conversation_id=$1 AND state IN ('failed','uncertain','pending','sending','window_expired') ORDER BY created_at DESC LIMIT 20",
      [conversation.id],
    );
    const { phone_hash, phone_encrypted, ...visible } = conversation;
    res.json({
      ...visible,
      phone: box.decrypt(phone_encrypted),
      messages: messages.reverse(),
      jobs,
    });
  });
  app.patch('/api/conversations/:id', async (req, res) => {
    const status = z.enum(['human', 'bot']).parse(req.body.status);
    await db.query('UPDATE conversations SET status=$1 WHERE id=$2', [
      status,
      req.params.id,
    ]);
    if (status === 'bot')
      await db.query(
        "UPDATE alerts SET resolved=true WHERE conversation_id=$1 AND kind='handoff'",
        [req.params.id],
      );
    res.json({ ok: true });
  });
  app.post('/api/conversations/:id/reply', async (req, res) => {
    const message = redact(
      z.string().trim().min(1).max(3500).parse(req.body.message),
    );
    const key = z.string().uuid().parse(req.body.request_id);
    const conversation = await db.one(
      'SELECT * FROM conversations WHERE id=$1',
      [req.params.id],
    );
    if (!conversation) return res.sendStatus(404);
    if (Date.now() - new Date(conversation.last_user_at).getTime() >= 86400000)
      return res.status(400).json({
        error:
          'The 24-hour reply window has closed. Wait for a new customer message.',
      });
    await db.query("UPDATE conversations SET status='human' WHERE id=$1", [
      conversation.id,
    ]);
    await db.query(
      "INSERT INTO jobs(id,meta_id,client_id,conversation_id,body,message_type) VALUES($1,$2,$3,$4,$5,'manual') ON CONFLICT(meta_id) DO NOTHING",
      [
        randomUUID(),
        'manual-' + key,
        conversation.client_id,
        conversation.id,
        message,
      ],
    );
    res.json({ ok: true });
  });
  app.delete('/api/conversations/:id', async (req, res) => {
    if (req.body.confirm !== 'DELETE')
      return res.status(400).json({ error: 'Type DELETE to confirm.' });
    await db.query('DELETE FROM conversations WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  });
  app.get('/api/alerts', async (_req, res) =>
    res.json(
      await db.all(
        'SELECT a.*,c.client_name FROM alerts a LEFT JOIN clients c ON c.id=a.client_id WHERE resolved=false ORDER BY created_at DESC LIMIT 100',
      ),
    ),
  );
  app.patch('/api/alerts/:id', async (req, res) => {
    await db.query('UPDATE alerts SET resolved=true WHERE id=$1', [
      req.params.id,
    ]);
    res.json({ ok: true });
  });
  app.get('/api/settings', async (_req, res) => {
    const master = await db.one(
      "SELECT value FROM settings WHERE id='master_prompt'",
    );
    const worker = await db.one(
      'SELECT expires_at>now() AS healthy FROM worker_lock WHERE id=1',
    );
    res.json({
      master_prompt: master.value.text,
      providers,
      webhook_url: config.appUrl + '/webhook',
      email_configured: Boolean(
        config.smtp.host && config.smtp.to && config.smtp.from,
      ),
      meta_secret_configured: Boolean(config.metaSecret),
      worker_healthy: Boolean(worker?.healthy),
      demo: config.demo,
      retention_days: 90,
    });
  });
  app.put('/api/settings/prompt', async (req, res) => {
    const prompt = z.string().trim().min(100).max(30000).parse(req.body.prompt);
    const reason = z.string().trim().min(3).max(500).parse(req.body.reason);
    await db.query(
      'INSERT INTO prompt_history(id,prompt,reason) VALUES($1,$2,$3)',
      [randomUUID(), prompt, reason],
    );
    await db.query("UPDATE settings SET value=$1 WHERE id='master_prompt'", [
      JSON.stringify({ text: prompt }),
    ]);
    res.json({ ok: true });
  });
  app.get('/api/settings/history', async (_req, res) =>
    res.json(
      await db.all(
        'SELECT * FROM prompt_history WHERE client_id IS NULL ORDER BY created_at DESC LIMIT 50',
      ),
    ),
  );
  app.get('/api/export', async (_req, res) => {
    const clients = await db.all('SELECT * FROM clients ORDER BY created_at');
    res
      .set(
        'Content-Disposition',
        'attachment; filename="relay-client-profiles.json"',
      )
      .json({
        exported_at: new Date().toISOString(),
        note: 'Credentials excluded. Use encrypted database backups for full recovery.',
        clients: clients.map(publicClient),
      });
  });
  mountEnhancements(app, { db, box, config, generate });
  app.use('/api', (_req, res) =>
    res.status(404).json({ error: 'This endpoint does not exist.' }),
  );
  app.use((error, req, res, _next) => {
    const providerError = error instanceof ProviderError;
    const showProviderError = providerError && Boolean(req.session?.admin);
    const status =
      error instanceof z.ZodError
        ? 400
        : error.code === '23505'
          ? 409
          : error.status || (providerError ? 502 : 500);
    console.error(
      JSON.stringify({
        event: 'request_failed',
        request_id: req.requestId,
        status,
        ...(providerError
          ? { code: error.code, upstream_status: error.upstreamStatus }
          : {}),
      }),
    );
    res.status(status).json({
      error:
        error instanceof z.ZodError
          ? error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')
          : error.code === '23505'
            ? 'That WhatsApp phone number ID is already assigned to a client.'
            : status < 500 || showProviderError
              ? error.message
              : 'The request could not be completed. Check the connection and configuration, then try again.',
      request_id: req.requestId,
      ...(showProviderError
        ? { code: error.code, upstream_status: error.upstreamStatus }
        : {}),
    });
  });
  return { app, box };
}
