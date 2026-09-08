import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomBytes, createHmac, randomUUID } from 'node:crypto';
import { createDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { initSettings, saveClient } from '../server/clients.js';
import { createWorker } from '../server/worker.js';
import {
  generateReply,
  sendWhatsApp,
  ProviderError,
} from '../server/providers.js';
import { readConfig } from '../server/config.js';
import { secretBox, verifySignature, redact } from '../server/security.js';
const config = {
  demo: true,
  production: false,
  appUrl: 'http://localhost:3000',
  localPath: 'memory://',
  encryptionKey: randomBytes(32).toString('hex'),
  sessionSecret: randomBytes(32).toString('hex'),
  password: 'test-password-not-real',
  verifyToken: 'test-verification-token-123456789',
  metaSecret: 'test-meta-secret',
  graphVersion: 'v23.0',
  trustProxy: 0,
  smtp: {},
};
let db,
  app,
  box,
  admin,
  csrf,
  first,
  second,
  sent = [];
before(async () => {
  db = await createDatabase(
    process.env.TEST_DATABASE_URL
      ? {
          ...config,
          demo: false,
          databaseUrl: process.env.TEST_DATABASE_URL,
          databaseSsl: false,
        }
      : config,
  );
  await db.migrate();
  await initSettings(db);
  ({ app, box } = createApp({ db, config }));
  admin = request.agent(app);
  const session = await admin.get('/api/session');
  csrf = session.body.csrf;
  const logged = await admin
    .post('/api/login')
    .set('x-csrf-token', csrf)
    .send({});
  assert.equal(logged.status, 200);
  csrf = logged.body.csrf;
});
after(async () => {
  await db.close();
});
const mutation = (method, path, body) =>
  admin[method]('/api' + path)
    .set('x-csrf-token', csrf)
    .send(body);
function payload(
  client,
  {
    id = randomUUID(),
    text = 'Hello',
    phone = '919123456789',
    timestamp = Math.floor(Date.now() / 1000),
    type = 'text',
  } = {},
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: client.phone_number_id },
              messages: [
                {
                  id,
                  from: phone,
                  timestamp: String(timestamp),
                  type,
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
function webhook(body, secret = config.metaSecret) {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set(
      'x-hub-signature-256',
      'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
    )
    .send(raw);
}
function worker(overrides = {}) {
  return createWorker({
    db,
    box,
    config,
    generate: async ({ client }) => ({
      text: 'Reply for ' + client.client_name,
      tokens: 50,
      cost: 0.005,
    }),
    send: async ({ client, phone, text }) => {
      sent.push({ client: client.id, phone, text });
      return { id: 'out-' + randomUUID() };
    },
    ...overrides,
  });
}
test('encryption is authenticated, randomized, and round-trips', () => {
  const a = box.encrypt('secret-value'),
    b = box.encrypt('secret-value');
  assert.notEqual(a, b);
  assert.equal(box.decrypt(a), 'secret-value');
  assert(!a.includes('secret-value'));
  const other = secretBox(randomBytes(32).toString('hex'));
  assert.throws(() => other.decrypt(a));
  assert.equal(box.phoneHash('123'), box.phoneHash('123'));
});
test('production configuration fails closed and demo cannot be deployed', () => {
  assert.throws(
    () => readConfig({ DEMO_MODE: 'true', NODE_ENV: 'production' }),
    /Demo/,
  );
  assert.throws(() => readConfig({}), /ENCRYPTION/);
});
test('admin data requires authentication and mutations require CSRF', async () => {
  assert.equal((await request(app).get('/api/clients')).status, 401);
  assert.equal((await admin.post('/api/clients').send({})).status, 403);
  assert.equal(
    (
      await admin
        .post('/api/clients')
        .set('x-csrf-token', csrf)
        .set('Origin', 'https://evil.example')
        .send({})
    ).status,
    403,
  );
});
test('login cookie is httpOnly and a wrong production-mode password is rejected', async () => {
  const { app: secureApp } = createApp({
    db,
    config: { ...config, demo: false },
  });
  const a = request.agent(secureApp);
  const s = await a.get('/api/session');
  assert(s.headers['set-cookie'][0].includes('HttpOnly'));
  assert(s.headers['set-cookie'][0].includes('SameSite=Strict'));
  assert.equal(
    (
      await a
        .post('/api/login')
        .set('x-csrf-token', s.body.csrf)
        .send({ password: 'wrong' })
    ).status,
    401,
  );
});
test('client creation encrypts credentials and public reads never reveal them', async () => {
  const res = await mutation('post', '/clients', {
    client_name: 'Test Dental',
    phone_number_id: '111111111111',
    llm_provider: 'gemini',
    llm_model: 'test-model',
    business_facts: 'Hours: Monday 9–5',
    whatsapp_access_token: 'private-wa-key',
    llm_api_key: 'private-llm-key',
    is_active: true,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  first = res.body;
  assert.equal(first.has_llm_api_key, true);
  assert(!JSON.stringify(first).includes('private-'));
  const row = await db.one('SELECT * FROM clients WHERE id=$1', [first.id]);
  assert.equal(
    box.decrypt(row.secrets.whatsapp_access_token),
    'private-wa-key',
  );
  assert(!JSON.stringify(row).includes('private-wa-key'));
  second = await saveClient(
    db,
    box,
    {
      client_name: 'Other Business',
      phone_number_id: '222222222222',
      llm_provider: 'deepseek',
      llm_model: 'deepseek-chat',
      is_active: true,
    },
    null,
    config,
  );
});
test('duplicate phone ID is rejected, blank secret updates preserve encryption', async () => {
  const dupe = await mutation('post', '/clients', {
    ...first,
    client_name: 'Duplicate',
  });
  assert.equal(dupe.status, 409);
  const update = await mutation('put', '/clients/' + first.id, {
    ...first,
    llm_api_key: '',
    whatsapp_access_token: '',
    business_facts: 'Hours: Monday 10–6',
    change_reason: 'Changed opening hours',
  });
  assert.equal(update.status, 200);
  first = update.body;
  const row = await db.one('SELECT * FROM clients WHERE id=$1', [first.id]);
  assert.equal(box.decrypt(row.secrets.llm_api_key), 'private-llm-key');
  assert(
    (await admin.get('/api/clients/' + first.id + '/history')).body.length >= 2,
  );
});
test('webhook verification and signature reject forged requests', async () => {
  const ok = await request(app).get('/webhook').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': config.verifyToken,
    'hub.challenge': '1234',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '1234');
  assert.equal(
    (
      await request(app)
        .get('/webhook')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad' })
    ).status,
    403,
  );
  assert.equal((await webhook(payload(first), 'bad-secret')).status, 403);
  assert.equal(
    verifySignature(Buffer.from('a'), 'sha256=00', config.metaSecret),
    false,
  );
});
test('signed duplicate webhook is durable and produces one routed response', async () => {
  sent = [];
  const body = payload(first, { id: 'dedupe-message' });
  assert.equal((await webhook(body)).status, 200);
  assert.equal((await webhook(body)).status, 200);
  assert.equal(
    (
      await db.one('SELECT count(*)::int AS n FROM jobs WHERE meta_id=$1', [
        'dedupe-message',
      ])
    ).n,
    1,
  );
  const w = worker();
  await w.tick();
  await w.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].client, first.id);
  assert.equal(
    (
      await db.one('SELECT state FROM jobs WHERE meta_id=$1', [
        'dedupe-message',
      ])
    ).state,
    'done',
  );
  await w.stop();
});
test('one endpoint isolates clients and honours per-app signing secrets', async () => {
  const row = await db.one('SELECT * FROM clients WHERE id=$1', [second.id]);
  await db.query('UPDATE clients SET secrets=$1 WHERE id=$2', [
    JSON.stringify({
      ...row.secrets,
      meta_app_secret: box.encrypt('second-app-secret'),
    }),
    second.id,
  ]);
  assert.equal((await webhook(payload(second))).status, 403);
  assert.equal(
    (await webhook(payload(second, { id: 'other-app' }), 'second-app-secret'))
      .status,
    200,
  );
  const w = worker();
  await w.tick();
  assert.equal(sent.at(-1).client, second.id);
  await w.stop();
});
test('handoff strips tag, pauses bot, creates alert and respects subsequent human handling', async () => {
  const w = worker({
    generate: async () => ({
      text: 'Let me ask the team. [NEEDS_HUMAN]',
      tokens: 1,
      cost: 0,
    }),
  });
  await webhook(payload(first, { id: 'handoff-1', phone: '919000000001' }));
  await w.tick();
  assert(!sent.at(-1).text.includes('[NEEDS_HUMAN]'));
  const c = await db.one('SELECT * FROM conversations WHERE phone_hash=$1', [
    box.phoneHash('919000000001'),
  ]);
  assert.equal(c.status, 'human');
  assert.equal(
    (
      await db.one(
        "SELECT count(*)::int AS n FROM alerts WHERE conversation_id=$1 AND kind='handoff'",
        [c.id],
      )
    ).n,
    1,
  );
  const count = sent.length;
  await webhook(payload(first, { id: 'handoff-2', phone: '919000000001' }));
  await w.tick();
  assert.equal(sent.length, count);
  assert.equal(
    (await db.one("SELECT state FROM jobs WHERE meta_id='handoff-2'")).state,
    'paused',
  );
  await w.stop();
});
test('paused client logs inbound but never calls AI or WhatsApp', async () => {
  await mutation('patch', '/clients/' + first.id + '/status', {
    is_active: false,
  });
  const count = sent.length;
  await webhook(payload(first, { id: 'kill-switch', phone: '919000000002' }));
  const w = worker({
    generate: async () => {
      throw new Error('Must not call AI');
    },
  });
  await w.tick();
  assert.equal(sent.length, count);
  assert.equal(
    (await db.one("SELECT state FROM jobs WHERE meta_id='kill-switch'")).state,
    'paused',
  );
  await mutation('patch', '/clients/' + first.id + '/status', {
    is_active: true,
  });
  await w.stop();
});
test('24-hour window blocks delayed incoming replies', async () => {
  const count = sent.length;
  await webhook(
    payload(first, {
      id: 'old-message',
      phone: '919000000003',
      timestamp: Math.floor(Date.now() / 1000) - 90000,
    }),
  );
  const w = worker();
  await w.tick();
  assert.equal(sent.length, count);
  assert.equal(
    (await db.one("SELECT state FROM jobs WHERE meta_id='old-message'")).state,
    'window_expired',
  );
  await w.stop();
});
test('retryable AI failures preserve order and use fallback after three attempts', async () => {
  await webhook(payload(first, { id: 'retry-ai', phone: '919000000004' }));
  await webhook(payload(first, { id: 'behind-retry', phone: '919000000004' }));
  const w = worker({
    generate: async () => {
      throw new ProviderError('temporary', true);
    },
  });
  await w.tick();
  assert.equal(
    (await db.one("SELECT state FROM jobs WHERE meta_id='retry-ai'")).state,
    'pending',
  );
  await w.tick();
  assert.equal(
    (await db.one("SELECT attempts FROM jobs WHERE meta_id='behind-retry'"))
      .attempts,
    0,
  );
  await db.query("UPDATE jobs SET available_at=now() WHERE meta_id='retry-ai'");
  await w.tick();
  await db.query("UPDATE jobs SET available_at=now() WHERE meta_id='retry-ai'");
  await w.tick();
  assert.equal(
    (await db.one("SELECT state FROM jobs WHERE meta_id='retry-ai'")).state,
    'done',
  );
  assert.equal(sent.at(-1).text, first.fallback_message);
  await db.query("UPDATE jobs SET state='paused' WHERE meta_id='behind-retry'");
  await w.stop();
});
test('ambiguous delivery is never retried automatically', async () => {
  await webhook(
    payload(first, { id: 'uncertain-message', phone: '919000000005' }),
  );
  let calls = 0;
  const w = worker({
    send: async () => {
      calls++;
      throw new ProviderError('timeout', false, true);
    },
  });
  await w.tick();
  await w.tick();
  assert.equal(calls, 1);
  assert.equal(
    (await db.one("SELECT state FROM jobs WHERE meta_id='uncertain-message'"))
      .state,
    'uncertain',
  );
  await w.stop();
});
test('crash recovery marks sending uncertain and recovers processing', async () => {
  await webhook(payload(first, { id: 'crashed-send', phone: '919000000006' }));
  await db.query(
    "UPDATE jobs SET state='sending',updated_at=now()-interval '3 minutes' WHERE meta_id='crashed-send'",
  );
  const w = worker();
  await w.tick();
  assert.equal(
    (await db.one("SELECT state FROM jobs WHERE meta_id='crashed-send'")).state,
    'uncertain',
  );
  await w.stop();
});
test('sensitive values are redacted before persistence and providers', async () => {
  await webhook(
    payload(first, {
      id: 'sensitive-message',
      text: 'My OTP is 123456 and card 4111 1111 1111 1111',
      phone: '919000000007',
    }),
  );
  const j = await db.one(
    "SELECT * FROM jobs WHERE meta_id='sensitive-message'",
  );
  assert(!j.body.includes('123456'));
  assert(!j.body.includes('4111'));
  const row = await db.one('SELECT * FROM clients WHERE id=$1', [first.id]);
  let calls = 0;
  const result = await generateReply({
    client: row,
    box,
    masterPrompt: '',
    messages: [{ role: 'user', content: j.body }],
    demo: false,
    fetchFn: async () => {
      calls++;
    },
  });
  assert.equal(calls, 0);
  assert.match(result.text, /privacy/);
  await db.query("UPDATE jobs SET state='paused' WHERE id=$1", [j.id]);
  assert.equal(redact('My password is secret123').includes('secret123'), false);
});
test('provider HTTP adapter sends only selected client config and counts cost', async () => {
  const row = await db.one('SELECT * FROM clients WHERE id=$1', [first.id]);
  row.config.input_price = 1;
  row.config.output_price = 2;
  let body;
  const result = await generateReply({
    client: row,
    box,
    masterPrompt: 'TEST SHARED RULE',
    messages: [{ role: 'user', content: 'Hours?' }],
    demo: false,
    fetchFn: async (url, opts) => {
      assert.match(url, /generativelanguage/);
      assert.equal(opts.headers.Authorization, 'Bearer private-llm-key');
      body = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Monday 10–6' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        { status: 200 },
      );
    },
  });
  assert.match(body.messages[0].content, /TEST SHARED RULE/);
  assert.match(body.messages[0].content, /Monday 10/);
  assert.equal(result.tokens, 150);
  assert.equal(result.cost, 0.0002);
});
test('manual reply is idempotent and deletion cascades all person data', async () => {
  const c = await db.one('SELECT * FROM conversations WHERE phone_hash=$1', [
    box.phoneHash('919000000001'),
  ]);
  const key = randomUUID();
  assert.equal(
    (
      await mutation('post', '/conversations/' + c.id + '/reply', {
        message: 'A person is here to help.',
        request_id: key,
      })
    ).status,
    200,
  );
  await mutation('post', '/conversations/' + c.id + '/reply', {
    message: 'A person is here to help.',
    request_id: key,
  });
  assert.equal(
    (
      await db.one('SELECT count(*)::int AS n FROM jobs WHERE meta_id=$1', [
        'manual-' + key,
      ])
    ).n,
    1,
  );
  const w = worker();
  await w.tick();
  assert.equal(sent.at(-1).text, 'A person is here to help.');
  await w.stop();
  assert.equal(
    (await mutation('delete', '/conversations/' + c.id, { confirm: 'wrong' }))
      .status,
    400,
  );
  assert.equal(
    (await mutation('delete', '/conversations/' + c.id, { confirm: 'DELETE' }))
      .status,
    200,
  );
  for (const table of ['message_logs', 'jobs', 'alerts'])
    assert.equal(
      (
        await db.one(
          `SELECT count(*)::int AS n FROM ${table} WHERE conversation_id=$1`,
          [c.id],
        )
      ).n,
      0,
    );
});
test('retention removes old contact records and message content', async () => {
  await webhook(
    payload(first, { id: 'retention-message', phone: '919000000008' }),
  );
  const c = await db.one('SELECT * FROM conversations WHERE phone_hash=$1', [
    box.phoneHash('919000000008'),
  ]);
  await db.query(
    "UPDATE conversations SET last_user_at=now()-interval '91 days' WHERE id=$1",
    [c.id],
  );
  const w = worker();
  await w.maintenance();
  assert.equal(
    await db.one('SELECT id FROM conversations WHERE id=$1', [c.id]),
    undefined,
  );
  assert.equal(
    await db.one("SELECT id FROM jobs WHERE meta_id='retention-message'"),
    undefined,
  );
});
test('Meta send adapter targets the right number and treats 5xx as uncertain', async () => {
  const row = await db.one('SELECT * FROM clients WHERE id=$1', [first.id]);
  await assert.rejects(
    sendWhatsApp({
      client: row,
      box,
      phone: '919000000009',
      text: 'Hello',
      config: { ...config, demo: false },
      fetchFn: async (url, opts) => {
        assert.match(url, /111111111111\/messages$/);
        const body = JSON.parse(opts.body);
        assert.equal(body.to, '919000000009');
        assert.equal(body.text.body, 'Hello');
        return new Response('{}', { status: 503 });
      },
    }),
    (e) => e.ambiguous === true,
  );
});
test('master prompt updates are versioned and exports exclude credentials', async () => {
  const text = 'Shared rule. '.repeat(20);
  assert.equal(
    (
      await mutation('put', '/settings/prompt', {
        prompt: text,
        reason: 'Test master version',
      })
    ).status,
    200,
  );
  assert.equal(
    (await admin.get('/api/settings')).body.master_prompt,
    text.trim(),
  );
  assert.equal(
    (await admin.get('/api/settings/history')).body[0].reason,
    'Test master version',
  );
  const exported = await admin.get('/api/export');
  assert.equal(exported.status, 200);
  assert(!exported.text.includes('private-wa-key'));
  assert(!exported.text.includes('secrets'));
});
test('three rapid messages preserve inbox order and both workers cannot claim together', async () => {
  for (let n = 0; n < 3; n++)
    await webhook(
      payload(first, {
        id: 'rapid-' + n,
        phone: '919000000011',
        text: 'Question ' + n,
      }),
    );
  const replies = [];
  const generator = async ({ messages }) => {
    replies.push(messages.at(-1).content);
    return { text: 'Answer', tokens: 1, cost: 0 };
  };
  const a = worker({ generate: generator }),
    b = worker({ generate: generator });
  await Promise.all([a.tick(), b.tick()]);
  assert.equal(replies.length, 1);
  await a.tick();
  await b.tick();
  await a.tick();
  await b.tick();
  assert.deepEqual(replies, ['Question 0', 'Question 1', 'Question 2']);
  await a.stop();
  await b.stop();
});
test('a kill switch changed during AI generation prevents delivery', async () => {
  await webhook(
    payload(first, { id: 'pause-during-generation', phone: '919000000012' }),
  );
  const count = sent.length;
  const w = worker({
    generate: async () => {
      await db.query('UPDATE clients SET is_active=false WHERE id=$1', [
        first.id,
      ]);
      return { text: 'This must not send', tokens: 1, cost: 0 };
    },
  });
  await w.tick();
  assert.equal(sent.length, count);
  assert.equal(
    (
      await db.one(
        "SELECT state FROM jobs WHERE meta_id='pause-during-generation'",
      )
    ).state,
    'paused',
  );
  await db.query('UPDATE clients SET is_active=true WHERE id=$1', [first.id]);
  await w.stop();
});
test('a database acknowledgement failure after sending is marked uncertain', async () => {
  await webhook(payload(first, { id: 'ack-failure', phone: '919000000013' }));
  let fail = true;
  const wrapped = {
    ...db,
    query: async (sql, args) => {
      if (fail && sql.includes("'outbound'")) {
        fail = false;
        throw new Error('simulated database acknowledgement failure');
      }
      return db.query(sql, args);
    },
  };
  const w = worker({ db: wrapped });
  await w.tick();
  assert.equal(
    (await db.one("SELECT state FROM jobs WHERE meta_id='ack-failure'")).state,
    'uncertain',
  );
  await w.stop();
});
test('early delivery receipts survive and stale receipts cannot downgrade status', async () => {
  const metaId = 'early-outbound-id';
  const statusPayload = (status) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: first.phone_number_id },
              statuses: [{ id: metaId, status }],
            },
          },
        ],
      },
    ],
  });
  assert.equal((await webhook(statusPayload('read'))).status, 200);
  await webhook(payload(first, { id: 'early-receipt', phone: '919000000014' }));
  const w = worker({ send: async () => ({ id: metaId }) });
  await w.tick();
  assert.equal(
    (await db.one('SELECT status FROM message_logs WHERE meta_id=$1', [metaId]))
      .status,
    'read',
  );
  await webhook(statusPayload('delivered'));
  assert.equal(
    (await db.one('SELECT status FROM message_logs WHERE meta_id=$1', [metaId]))
      .status,
    'read',
  );
  await webhook(statusPayload('failed'));
  await webhook(statusPayload('failed'));
  const log = await db.one('SELECT * FROM message_logs WHERE meta_id=$1', [
    metaId,
  ]);
  assert.equal(
    (
      await db.one(
        "SELECT count(*)::int AS n FROM alerts WHERE conversation_id=$1 AND kind='delivery'",
        [log.conversation_id],
      )
    ).n,
    1,
  );
  await w.stop();
});
test('malformed signed payloads cannot create work', async () => {
  assert.equal(
    (
      await webhook({
        object: 'whatsapp_business_account',
        entry: { changes: [] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await webhook({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              { field: 'messages', value: { messages: { bad: true } } },
            ],
          },
        ],
      })
    ).status,
    400,
  );
});
