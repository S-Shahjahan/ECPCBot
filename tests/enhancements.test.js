import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import request from 'supertest';
import JSZip from 'jszip';
import sharp from 'sharp';
import { createDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { saveClient, initSettings } from '../server/clients.js';
import { csvCell } from '../server/enhancements.js';
import { publicAddress, externalUrl, publicFetch } from '../server/outbound.js';
import {
  extractFile,
  saveSource,
  retrieveKnowledge,
} from '../server/knowledge.js';
import {
  bookingSlot,
  handleCustomerAction,
  prepareCustomerAction,
  actionTools,
} from '../server/google.js';
import { renderWebsite } from '../server/render-website.js';
import { createCrawlWorker } from '../server/crawls.js';
import { createWorker as createMessageWorker } from '../server/worker.js';
import { conversationContext, plainReply } from '../server/conversation.js';
import * as XLSX from 'xlsx';
import CFB from 'cfb';
import { generateReply } from '../server/providers.js';
import { MASTER_PROMPT, LEGACY_MASTER_PROMPT } from '../server/prompts.js';
const config = {
  demo: true,
  production: false,
  appUrl: 'http://localhost:3000',
  localPath: 'memory://',
  encryptionKey: randomBytes(32).toString('hex'),
  sessionSecret: randomBytes(32).toString('hex'),
  password: 'a-long-testing-password',
  trustProxy: 0,
  verifyToken: 'a-test-token-long-enough',
  smtp: {},
  googleClientId: 'fake-oauth-id',
  googleClientSecret: 'fake-oauth-secret',
};
let db, app, box, admin, csrf, client, other, conversation;
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
  csrf = (await admin.get('/api/session')).body.csrf;
  csrf = (await admin.post('/api/login').set('x-csrf-token', csrf).send({}))
    .body.csrf;
  client = await saveClient(
    db,
    box,
    {
      client_name: 'Enhancement test',
      phone_number_id: '8800' + Date.now(),
      llm_provider: 'gemini',
      llm_model: 'gemini-3.1-flash-lite',
      llm_api_key: 'test-ai-key',
    },
    null,
    config,
  );
  other = await saveClient(
    db,
    box,
    {
      client_name: 'Isolated client',
      phone_number_id: '9900' + Date.now(),
      llm_provider: 'gemini',
      llm_model: 'gemini-3.1-flash-lite',
    },
    null,
    config,
  );
  const phone = '919876543210';
  conversation = await db.one(
    'INSERT INTO conversations(id,client_id,phone_hash,phone_encrypted,phone_label,last_user_at) VALUES($1,$2,$3,$4,$5,now()) RETURNING *',
    [
      randomUUID(),
      client.id,
      box.phoneHash(phone),
      box.encrypt(phone),
      '•••• 3210',
    ],
  );
});
after(async () => {
  if (client)
    await db.query('DELETE FROM clients WHERE id IN ($1,$2)', [
      client.id,
      other.id,
    ]);
  await db.close();
});
const mutate = (method, path, body) =>
  admin[method]('/api' + path)
    .set('x-csrf-token', csrf)
    .send(body);

test('outbound guard rejects private, mapped, link-local and non-HTTPS destinations', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.1.2',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
    '0.0.0.0',
    '224.0.0.1',
    '192.0.2.1',
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  for (const url of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com:444',
    'file:///etc/passwd',
  ])
    assert.throws(() => externalUrl(url));
  await assert.rejects(publicFetch('https://127.0.0.1'), /Private/);
});
test('changing provider destination cannot reuse an existing secret implicitly', async () => {
  await assert.rejects(
    saveClient(
      db,
      box,
      { ...client, llm_base_url: 'https://example.com/v1' },
      client.id,
      config,
    ),
    /Re-enter/,
  );
  const response = await mutate('post', `/clients/${client.id}/ai-test`, {});
  assert.equal(response.status, 200);
  assert.equal(response.body.demo, true);
  assert.match(response.body.message, /no AI request/);
});
test('source approval and retrieval remain isolated per client', async () => {
  const a = await saveSource(db, client.id, {
    title: 'Services',
    content: 'We offer wedding cakes. A tasting costs 500 rupees.',
    approved: true,
  });
  await saveSource(db, client.id, {
    title: 'Unreviewed',
    content: 'Hidden launch promotion secret offer',
    approved: false,
  });
  await saveSource(db, other.id, {
    title: 'Other business',
    content: 'Private other-client wedding secret.',
    approved: true,
  });
  const text = await retrieveKnowledge(db, client.id, 'wedding cakes price');
  assert.match(text, /500 rupees/);
  assert(!text.includes('secret'));
  assert.equal(
    (await admin.get(`/api/clients/${other.id}/sources/${a.id}`)).status,
    404,
  );
  assert.equal(
    (await request(app).get(`/api/clients/${client.id}/sources`)).status,
    401,
  );
  assert.equal(
    (await admin.post(`/api/clients/${client.id}/sources`).send({})).status,
    403,
  );
  assert.equal(
    (
      await mutate('patch', `/clients/${client.id}/sources/${a.id}`, {
        approved: false,
      })
    ).status,
    200,
  );
  assert.equal(await retrieveKnowledge(db, client.id, 'cakes'), '');
});
test('text and Word uploads produce reviewable text without retaining files', async () => {
  const imported = await admin
    .post(`/api/clients/${client.id}/import-file`)
    .set('x-csrf-token', csrf)
    .attach('file', Buffer.from('Bakery hours: Monday 10am.\nOTP: 123456'), {
      filename: 'facts.txt',
      contentType: 'text/plain',
    });
  assert.equal(imported.status, 200);
  assert.match(imported.body.text, /Bakery/);
  assert(!imported.body.text.includes('123456'));
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Cakes are available on Saturday.</w:t></w:r></w:p></w:body></w:document>',
  );
  const word = await extractFile({
    originalname: 'facts.docx',
    buffer: await zip.generateAsync({ type: 'nodebuffer' }),
  });
  assert.match(word.text, /Cakes are available/);
  await assert.rejects(
    extractFile({ originalname: 'bad.exe', buffer: Buffer.from('bad') }),
    /Use PDF/,
  );
});
function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream =
    'BT /F1 16 Tf 50 700 Td (Our bakery offers wedding cakes and tastings every Saturday.) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let text = '%PDF-1.4\n',
    offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text);
}
test('PDF extraction reads a real document and rejects corrupt input', async () => {
  const result = await extractFile({
    originalname: 'brochure.pdf',
    buffer: pdfFixture(),
  });
  assert.match(result.text, /wedding cakes/);
  await assert.rejects(
    extractFile({ originalname: 'bad.pdf', buffer: Buffer.from('not pdf') }),
    /not a valid PDF/,
  );
});
test('image OCR extracts text locally', async () => {
  const png = await sharp(
    Buffer.from(
      '<svg width="1400" height="300" xmlns="http://www.w3.org/2000/svg"><rect width="1400" height="300" fill="white"/><text x="50" y="150" font-family="sans-serif" font-size="72" fill="black">BAKERY OPEN MONDAY</text></svg>',
    ),
  )
    .png()
    .toBuffer();
  const result = await extractFile({ originalname: 'hours.png', buffer: png });
  assert.match(result.text, /BAKERY/i);
  assert.match(result.note, /OCR/);
});
test('CSV safely quotes formulas, preserves mobile numbers and includes full chat rows', async () => {
  assert.equal(csvCell('=HYPERLINK("evil")'), '"\'=HYPERLINK(""evil"")"');
  assert.equal(csvCell('+919876543210'), '"\'+919876543210"');
  await db.query(
    "INSERT INTO message_logs(id,client_id,conversation_id,direction,body,status) VALUES($1,$2,$3,'inbound',$4,'received')",
    [
      randomUUID(),
      client.id,
      conversation.id,
      '=HYPERLINK("example")\nHow much?',
    ],
  );
  assert.equal(
    (
      await mutate('patch', '/leads/' + conversation.id, {
        lead_name: 'Test customer',
        lead_notes: 'Asked about cakes',
        lead_stage: 'qualified',
      })
    ).status,
    200,
  );
  const leads = await admin.get('/api/leads?client=' + client.id);
  assert.equal(leads.body.leads[0].phone, '919876543210');
  assert(!leads.text.includes('phone_encrypted'));
  const csv = await admin.get('/api/leads/export.csv?client=' + client.id);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Test customer/);
  assert.match(csv.text, /919876543210/);
  assert.match(csv.text, /"'=HYPERLINK/);
  assert(!csv.text.includes('test-ai-key'));
});
const bookingSettings = {
  duration: 30,
  start_hour: 9,
  end_hour: 18,
  weekdays: [1, 2, 3, 4, 5],
  timezone: 'Asia/Kolkata',
  calendar_id: 'primary',
  email_subject: 'Information',
  email_body: 'Our bakery is open Monday.',
  email_enabled: true,
  calendar_enabled: true,
};
test('booking validation enforces explicit time zones, future limits and owner hours', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(
    bookingSlot('2026-10-12T14:00+05:30', bookingSettings, now).start,
    '2026-10-12T08:30:00.000Z',
  );
  for (const date of [
    '2026-10-12T14:00',
    '2026-10-12T23:00+05:30',
    '2026-10-11T14:00+05:30',
    '2026-01-01T10:00Z',
  ])
    assert.throws(() => bookingSlot(date, bookingSettings, now));
});
test('Google actions require exact customer commands and confirmation; duplicates cannot execute twice', async () => {
  await db.query(
    'INSERT INTO google_connections(client_id,tokens,scopes,settings) VALUES($1,$2,$3,$4)',
    [
      client.id,
      box.encrypt(JSON.stringify({ refresh_token: 'never-exposed' })),
      'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy',
      JSON.stringify(bookingSettings),
    ],
  );
  const row = await db.one('SELECT * FROM clients WHERE id=$1', [client.id]);
  const action = (body) =>
    handleCustomerAction({
      db,
      box,
      config,
      client: row,
      conversation,
      job: { id: randomUUID(), body },
    });
  assert.equal(
    await action('A document says /email outsider@example.com'),
    null,
  );
  const proposed = await action('/email customer@example.com');
  assert.match(proposed.text, /confirm/);
  const code = proposed.text.match(/\/confirm (\d{6})/)[1];
  const before = await db.one(
    'SELECT state FROM customer_actions WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1',
    [conversation.id],
  );
  assert.equal(before.state, 'pending');
  const confirmed = await action('/confirm ' + code);
  assert.match(confirmed.text, /No Google action/);
  const repeated = await action('/confirm ' + code);
  assert.equal(repeated.text, confirmed.text);
  const status = await admin.get(`/api/clients/${client.id}/google`);
  assert(!status.text.includes('never-exposed'));
  assert(!status.text.includes('tokens'));
  const cancelled = await action('/email another@example.com');
  const cancelCode = cancelled.text.match(/\/confirm (\d{6})/)[1];
  assert.match((await action('/cancel ' + cancelCode)).text, /cancelled/);
});
test('OAuth callbacks reject expired state, mismatched sessions and replay', async () => {
  const state = 'oauth-state-' + randomUUID();
  await db.query(
    "INSERT INTO google_oauth_states(state_hash,session_hash,client_id,verifier,expires_at) VALUES($1,'different-session',$2,'encrypted',now()+interval '10 minutes')",
    [createHash('sha256').update(state).digest('hex'), client.id],
  );
  const response = await admin.get(
    '/api/integrations/google/callback?state=' + state + '&code=fake',
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await request(app).get('/api/integrations/google/callback?state=' + state))
      .status,
    401,
  );
});
test('master default upgrades only unchanged shipped rules', async () => {
  const old = await db.one(
    "SELECT value FROM settings WHERE id='master_prompt'",
  );
  await db.query("UPDATE settings SET value=$1 WHERE id='master_prompt'", [
    JSON.stringify({ text: LEGACY_MASTER_PROMPT }),
  ]);
  await initSettings(db);
  assert.equal(
    (await db.one("SELECT value FROM settings WHERE id='master_prompt'")).value
      .text,
    MASTER_PROMPT,
  );
  await db.query("UPDATE settings SET value=$1 WHERE id='master_prompt'", [
    JSON.stringify({ text: 'My custom owner rules' }),
  ]);
  await initSettings(db);
  assert.equal(
    (await db.one("SELECT value FROM settings WHERE id='master_prompt'")).value
      .text,
    'My custom owner rules',
  );
  await db.query("UPDATE settings SET value=$1 WHERE id='master_prompt'", [
    JSON.stringify(old.value),
  ]);
});
test('Anthropic uses native headers, system separation and token accounting', async () => {
  const row = await db.one('SELECT * FROM clients WHERE id=$1', [client.id]);
  const result = await generateReply({
    client: {
      ...row,
      config: {
        ...row.config,
        llm_provider: 'anthropic',
        llm_model: 'claude-sonnet-4-6',
      },
    },
    box,
    masterPrompt: MASTER_PROMPT,
    messages: [{ role: 'user', content: 'hello' }],
    demo: false,
    fetchFn: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.headers['x-api-key'], 'test-ai-key');
      const body = JSON.parse(options.body);
      assert.match(body.system, /NON-OVERRIDABLE/);
      assert.equal(body.messages[0].role, 'user');
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Hello from the bakery.' }],
          usage: { input_tokens: 12, output_tokens: 8 },
        }),
      );
    },
  });
  assert.equal(result.tokens, 20);
  assert.match(result.text, /bakery/);
});
test('live Google adapter sends only confirmed template email and does not repeat an uncertain send', async (t) => {
  await db.query('UPDATE clients SET is_active=true WHERE id=$1', [client.id]);
  await db.query('DELETE FROM customer_actions WHERE conversation_id=$1', [
    conversation.id,
  ]);
  await db.query(
    'UPDATE google_connections SET tokens=$1,settings=$2 WHERE client_id=$3',
    [
      box.encrypt(
        JSON.stringify({
          access_token: 'fake-google-access',
          refresh_token: 'fake-refresh',
          expires_at: Date.now() + 3600000,
        }),
      ),
      JSON.stringify(bookingSettings),
      client.id,
    ],
  );
  const row = await db.one('SELECT * FROM clients WHERE id=$1', [client.id]);
  let sends = 0,
    ambiguous = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo')
      return new Response(JSON.stringify({ email: 'business@example.com' }));
    assert.equal(
      url,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    );
    const raw = Buffer.from(
      JSON.parse(options.body).raw,
      'base64url',
    ).toString();
    assert.match(raw, /To: customer@example.com\r\n/);
    assert(!raw.includes('How much?'));
    assert.equal(
      Buffer.from(raw.split('\r\n\r\n')[1], 'base64').toString(),
      bookingSettings.email_body,
    );
    sends++;
    if (ambiguous) throw new Error('network disconnected');
    return new Response(JSON.stringify({ id: 'fake-mail-id' }));
  });
  const act = (body) =>
    handleCustomerAction({
      db,
      box,
      config: { ...config, demo: false },
      client: row,
      conversation,
      job: { id: randomUUID(), body },
    });
  const proposal = await act('/email customer@example.com');
  assert.equal(sends, 0);
  const code = proposal.text.match(/\/confirm (\d{6})/)[1];
  assert.match((await act('/confirm ' + code)).text, /was emailed/);
  assert.equal(sends, 1);
  await act('/confirm ' + code);
  assert.equal(sends, 1);
  ambiguous = true;
  const second = await act('/email customer@example.com');
  const code2 = second.text.match(/\/confirm (\d{6})/)[1];
  assert.match((await act('/confirm ' + code2)).text, /NEEDS_HUMAN/);
  assert.equal(sends, 2);
  await act('/confirm ' + code2);
  assert.equal(sends, 2);
  const third = await act('/email customer@example.com');
  const code3 = third.text.match(/\/confirm (\d{6})/)[1];
  await db.query('UPDATE clients SET is_active=false WHERE id=$1', [client.id]);
  assert.match((await act('/confirm ' + code3)).text, /paused/);
  assert.equal(sends, 2);
});
test('live booking checks availability and creates only the confirmed event', async (t) => {
  await db.query('UPDATE clients SET is_active=true WHERE id=$1', [client.id]);
  await db.query('DELETE FROM customer_actions WHERE conversation_id=$1', [
    conversation.id,
  ]);
  const row = await db.one('SELECT * FROM clients WHERE id=$1', [client.id]);
  const start = new Date(Date.now() + 3 * 86400000);
  start.setUTCHours(8, 30, 0, 0);
  while ([0, 6].includes(start.getUTCDay()))
    start.setUTCDate(start.getUTCDate() + 1);
  let events = 0,
    busy = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/freeBusy'))
      return new Response(
        JSON.stringify({
          calendars: {
            primary: {
              busy: busy
                ? [
                    {
                      start: start.toISOString(),
                      end: new Date(start.getTime() + 1800000).toISOString(),
                    },
                  ]
                : [],
            },
          },
        }),
      );
    assert.match(url, /calendars\/primary\/events\?sendUpdates=all/);
    assert.deepEqual(body.attendees, [{ email: 'customer@example.com' }]);
    assert.equal(body.start.dateTime, start.toISOString());
    assert.match(body.id, /^[a-f0-9]{40}$/);
    events++;
    return new Response(JSON.stringify({ id: body.id }));
  });
  const act = (body) =>
    handleCustomerAction({
      db,
      box,
      config: { ...config, demo: false },
      client: row,
      conversation,
      job: { id: randomUUID(), body },
    });
  const command =
    '/book ' +
    start.toISOString().replace('.000Z', 'Z') +
    ' customer@example.com';
  const proposal = await act(command);
  const code = proposal.text.match(/\/confirm (\d{6})/)[1];
  assert.equal(events, 0);
  assert.match((await act('/confirm ' + code)).text, /is booked/);
  assert.equal(events, 1);
  await act('/confirm ' + code);
  assert.equal(events, 1);
  busy = true;
  const second = await act(command);
  const code2 = second.text.match(/\/confirm (\d{6})/)[1];
  assert.match((await act('/confirm ' + code2)).text, /no longer free/);
  assert.equal(events, 1);
});
test('OAuth exchanges a valid state once and encrypts credentials without leaking tokens', async (t) => {
  const live = createApp({ db, config: { ...config, demo: false } }).app;
  const session = request.agent(live);
  let token = (await session.get('/api/session')).body.csrf;
  token = (
    await session
      .post('/api/login')
      .set('x-csrf-token', token)
      .send({ password: config.password })
  ).body.csrf;
  const connect = await session
    .post(`/api/clients/${other.id}/google/connect`)
    .set('x-csrf-token', token)
    .send({ gmail: true, calendar: false });
  assert.equal(connect.status, 200);
  const url = new URL(connect.body.url),
    state = url.searchParams.get('state');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (endpoint, options) => {
    assert.equal(endpoint, 'https://oauth2.googleapis.com/token');
    assert.equal(options.body.get('code'), 'fake-code');
    assert(options.body.get('code_verifier'));
    requests++;
    return new Response(
      JSON.stringify({
        access_token: 'private-access',
        refresh_token: 'private-refresh',
        expires_in: 3600,
        scope: 'openid email https://www.googleapis.com/auth/gmail.send',
      }),
    );
  });
  const callback = await session.get(
    '/api/integrations/google/callback?state=' + state + '&code=fake-code',
  );
  assert.equal(callback.status, 302);
  assert(callback.headers.location.endsWith('?google=connected'));
  assert.equal(requests, 1);
  const saved = await db.one(
    'SELECT * FROM google_connections WHERE client_id=$1',
    [other.id],
  );
  assert(!saved.tokens.includes('private-refresh'));
  assert.match(box.decrypt(saved.tokens), /private-refresh/);
  assert.equal(
    (
      await session.get(
        '/api/integrations/google/callback?state=' + state + '&code=fake-code',
      )
    ).status,
    400,
  );
  assert.equal(requests, 1);
  const status = await session.get(`/api/clients/${other.id}/google`);
  assert(!status.text.includes('private-access'));
  const next = await session
    .post(`/api/clients/${other.id}/google/connect`)
    .set('x-csrf-token', token)
    .send({ gmail: true, calendar: false });
  await db.query(
    "UPDATE google_oauth_states SET expires_at=now()-interval '1 minute' WHERE client_id=$1",
    [other.id],
  );
  assert.equal(
    (
      await session.get(
        '/api/integrations/google/callback?state=' +
          new URL(next.body.url).searchParams.get('state') +
          '&code=fake-code',
      )
    ).status,
    400,
  );
  assert.equal(requests, 1);
});

test('Excel, PowerPoint, legacy PPT and Markdown imports preserve business details', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['Product', 'Price'],
      ['Business cards', 500],
    ]),
    'Catalogue',
  );
  for (const ext of ['xlsx', 'xls']) {
    const result = await extractFile({
      originalname: 'catalogue.' + ext,
      buffer: XLSX.write(book, {
        type: 'buffer',
        bookType: ext === 'xls' ? 'biff8' : 'xlsx',
      }),
    });
    assert.match(result.text, /Product: Business cards/);
    assert.match(result.text, /Price: 500/);
  }
  const zip = new JSZip();
  zip.file(
    'ppt/slides/slide1.xml',
    '<p:sld><a:p><a:r><a:t>Premium printing services</a:t></a:r></a:p></p:sld>',
  );
  const slides = await extractFile({
    originalname: 'services.pptx',
    buffer: await zip.generateAsync({ type: 'nodebuffer' }),
  });
  assert.match(slides.text, /Slide 1[\s\S]*Premium printing/);
  const text = Buffer.from('Legacy presentation details', 'utf16le'),
    record = Buffer.alloc(8);
  record.writeUInt16LE(4000, 2);
  record.writeUInt32LE(text.length, 4);
  const compound = CFB.utils.cfb_new();
  CFB.utils.cfb_add(
    compound,
    'PowerPoint Document',
    Buffer.concat([record, text]),
  );
  const legacy = await extractFile({
    originalname: 'legacy.ppt',
    buffer: CFB.write(compound, { type: 'buffer' }),
  });
  assert.match(legacy.text, /Legacy presentation details/);
  assert.match(
    (
      await extractFile({
        originalname: 'facts.md',
        buffer: Buffer.from('# Services\nBusiness cards'),
      })
    ).text,
    /Business cards/,
  );
});

test('rendered website extraction waits for JavaScript content and reads rendered links', async () => {
  const page = await renderWebsite('https://example.com/', async (url) => {
    assert.equal(url, 'https://example.com/');
    return new Response(
      '<html><title>Rendered shop</title><body><div id="root"></div><script>setTimeout(() => { document.getElementById("root").innerHTML = "<h1>Rendered printing services</h1><p>' +
        'Business cards and wedding invitations. '.repeat(10) +
        '</p><a href=/products>Products</a>"; }, 200)</script></body></html>',
      { headers: { 'content-type': 'text/html' } },
    );
  });
  assert.match(page.text, /Rendered printing services/);
  assert(page.links.includes('https://example.com/products'));
  assert(!page.text.includes('setTimeout'));
});

test('durable website crawl exceeds eight pages, survives restart, stops, resumes and requires source approval', async () => {
  const created = await mutate('post', '/clients/' + other.id + '/crawls', {
    url: 'https://example.com/',
    follow: true,
  });
  assert.equal(created.status, 202);
  const fake = {
    db,
    fetchFn: async () => new Response('', { status: 404 }),
    render: async (url) => ({
      title: 'Printing page',
      text: 'Source ' + url + ' describes premium printing.',
      links:
        url === 'https://example.com/'
          ? Array.from(
              { length: 12 },
              (_, i) => 'https://example.com/page-' + i,
            ).concat(['https://outsider.example/'])
          : [],
    }),
  };
  const first = createCrawlWorker(fake);
  await first.tick();
  await first.stop();
  await mutate(
    'post',
    '/clients/' + other.id + '/crawls/' + created.body.id + '/stop',
    {},
  );
  const restarted = createCrawlWorker(fake);
  await restarted.tick();
  let run = await db.one('SELECT * FROM crawl_runs WHERE id=$1', [
    created.body.id,
  ]);
  assert.equal(run.completed, 1);
  await mutate(
    'post',
    '/clients/' + other.id + '/crawls/' + created.body.id + '/resume',
    {},
  );
  for (let i = 0; i < 13; i++) await restarted.tick();
  run = await db.one('SELECT * FROM crawl_runs WHERE id=$1', [created.body.id]);
  assert.equal(run.status, 'completed');
  assert.equal(run.completed, 13);
  assert.equal(run.failed, 0);
  const sources = await db.all(
    "SELECT * FROM knowledge_sources WHERE client_id=$1 AND origin LIKE 'https://example.com/%'",
    [other.id],
  );
  assert.equal(sources.length, 13);
  assert(sources.every((s) => !s.approved));
  assert.equal(
    (
      await db.one(
        'SELECT count(*)::int AS n FROM knowledge_chunks WHERE source_id=$1',
        [sources[0].id],
      )
    ).n,
    1,
  );
  assert.equal(
    (
      await mutate(
        'post',
        '/clients/' + client.id + '/crawls/' + created.body.id + '/resume',
        {},
      )
    ).status,
    400,
  );
  await restarted.stop();
});

test('AI configuration can discover and test before saving without changing saved credentials', async () => {
  const before = await db.one('SELECT * FROM clients WHERE id=$1', [client.id]);
  const data = {
    client_id: client.id,
    provider: 'gemini',
    api_key: 'unsaved-test-key',
    model: 'gemini-3.1-flash-lite',
  };
  assert.equal((await mutate('post', '/ai/models', data)).status, 200);
  assert.equal((await mutate('post', '/ai/test', data)).status, 200);
  const after = await db.one('SELECT * FROM clients WHERE id=$1', [client.id]);
  assert.deepEqual(after.secrets, before.secrets);
  assert.deepEqual(after.config, before.config);
  assert.equal(
    (
      await mutate('post', '/ai/models', {
        ...data,
        base_url: 'http://127.0.0.1',
      })
    ).status,
    400,
  );
});

test('conversation context keeps initial preferences and recent follow-ups; replies strip Markdown tables', () => {
  const turns = Array.from({ length: 90 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content:
      (i === 0
        ? 'I want matte finish. '
        : i === 89
          ? 'What about that finish? '
          : 'Details ') + 'x'.repeat(1500),
  }));
  const context = conversationContext(turns);
  assert.match(context[0].content, /matte/);
  assert.match(context.at(-1).content, /that finish/);
  assert(context.reduce((n, m) => n + m.content.length, 0) <= 48000);
  const plain = plainReply(
    '## Options\n**Premium**\n| Product | Price |\n| --- | --- |\n| Cards | ₹500 |\n- Ask us\n[NEEDS_HUMAN]',
  );
  assert(!/[#*|]/.test(plain));
  assert.match(plain, /Product: Cards. Price: ₹500/);
  assert.match(plain, /\[NEEDS_HUMAN\]/);
});

test('tool calls prepare Google actions, require a delivered confirmation, and naturally confirm email and booking once', async (t) => {
  await db.query('DELETE FROM customer_actions WHERE conversation_id=$1', [
    conversation.id,
  ]);
  await db.query(
    "UPDATE conversations SET status='bot',last_user_at=now() WHERE id=$1",
    [conversation.id],
  );
  await db.query('UPDATE clients SET is_active=true WHERE id=$1', [client.id]);
  await db.query(
    'UPDATE google_connections SET settings=$1,scopes=$2,tokens=$3 WHERE client_id=$4',
    [
      JSON.stringify(bookingSettings),
      'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy',
      box.encrypt(
        JSON.stringify({
          access_token: 'fake-google-access',
          expires_at: Date.now() + 3600000,
        }),
      ),
      client.id,
    ],
  );
  const row = await db.one('SELECT * FROM clients WHERE id=$1', [client.id]);
  const context = {
    db,
    box,
    config: { ...config, demo: false },
    client: row,
    conversation,
  };
  let sends = 0,
    events = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('userinfo'))
      return new Response(JSON.stringify({ email: 'owner@example.com' }));
    if (url.endsWith('/freeBusy'))
      return new Response(
        JSON.stringify({ calendars: { primary: { busy: [] } } }),
      );
    if (url.includes('/events?')) {
      events++;
      return new Response(JSON.stringify({ id: 'event-created' }));
    }
    assert(url.endsWith('/messages/send'));
    const raw = Buffer.from(
      JSON.parse(options.body).raw,
      'base64url',
    ).toString();
    assert.match(raw, /From: owner@example.com/);
    assert.match(raw, /To: customer@example.com/);
    sends++;
    return new Response(JSON.stringify({ id: 'mail-created' }));
  });
  const messages = [
    {
      role: 'user',
      content: 'Please email me the details at customer@example.com',
    },
  ];
  const proposal = {
    name: 'prepare_email',
    arguments: { email: 'customer@example.com' },
  };
  const prepared = await prepareCustomerAction(
    { ...context, job: { id: randomUUID() } },
    proposal,
    messages,
  );
  assert.match(prepared.text, /Reply yes/);
  assert.equal(sends, 0);
  const act = (body) =>
    handleCustomerAction({ ...context, job: { id: randomUUID(), body } });
  assert.equal(await act('yes'), null);
  assert.equal(sends, 0);
  await db.query(
    "INSERT INTO message_logs(id,client_id,conversation_id,direction,body,status,created_at) VALUES($1,$2,$3,'outbound',$4,'sent',now())",
    [randomUUID(), client.id, conversation.id, prepared.text],
  );
  assert.match((await act('yes please')).text, /was emailed/);
  assert.equal(sends, 1);
  await act('yes');
  assert.equal(sends, 1);
  const malicious = await prepareCustomerAction(
    { ...context, job: { id: randomUUID() } },
    { name: 'prepare_email', arguments: { email: 'outsider@example.com' } },
    messages,
  );
  assert.match(malicious.text, /What is your email/);
  assert.equal(sends, 1);
  const start = new Date(Date.now() + 3 * 86400000);
  start.setUTCHours(8, 30, 0, 0);
  while ([0, 6].includes(start.getUTCDay()))
    start.setUTCDate(start.getUTCDate() + 1);
  const booking = await prepareCustomerAction(
    { ...context, job: { id: randomUUID() } },
    {
      name: 'prepare_call',
      arguments: { email: 'customer@example.com', start: start.toISOString() },
    },
    [
      ...messages,
      { role: 'user', content: 'Please book a call at ' + start.toISOString() },
    ],
  );
  assert.equal(events, 0);
  await db.query(
    "INSERT INTO message_logs(id,client_id,conversation_id,direction,body,status,created_at) VALUES($1,$2,$3,'outbound',$4,'sent',now())",
    [randomUUID(), client.id, conversation.id, booking.text],
  );
  assert.match((await act('go ahead')).text, /call is booked/);
  assert.equal(events, 1);
  await act('yes');
  assert.equal(events, 1);
});

test('Gemini and Anthropic tool response adapters retain prior conversation and return a proposal without claiming success', async () => {
  const row = await db.one('SELECT * FROM clients WHERE id=$1', [client.id]);
  for (const provider of ['gemini', 'anthropic']) {
    const result = await generateReply({
      client: {
        ...row,
        config: { ...row.config, llm_provider: provider, llm_base_url: '' },
      },
      box,
      masterPrompt: '',
      messages: [
        { role: 'user', content: 'My email is customer@example.com' },
        { role: 'assistant', content: 'How can I help?' },
        { role: 'user', content: 'Email me the business information' },
      ],
      demo: false,
      actionTools: await actionTools(db, client.id),
      fetchFn: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert(body.tools.length === 2);
        assert(
          body.messages.some((m) => m.content.includes('customer@example.com')),
        );
        return new Response(
          JSON.stringify(
            provider === 'anthropic'
              ? {
                  content: [
                    {
                      type: 'tool_use',
                      name: 'prepare_email',
                      input: { email: 'customer@example.com' },
                    },
                  ],
                  usage: { input_tokens: 10, output_tokens: 5 },
                }
              : {
                  choices: [
                    {
                      message: {
                        content: null,
                        tool_calls: [
                          {
                            function: {
                              name: 'prepare_email',
                              arguments: JSON.stringify({
                                email: 'customer@example.com',
                              }),
                            },
                          },
                        ],
                      },
                    },
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 5 },
                },
          ),
        );
      },
    });
    assert.equal(result.proposedAction.name, 'prepare_email');
    assert.equal(result.tokens, 15);
    assert.equal(result.text, '');
  }
});

test('WhatsApp worker prepares a model action and processes a natural confirmation in the next message', async () => {
  // PostgreSQL CI shares the database with the preceding test file.
  await db.query('UPDATE worker_lock SET expires_at=now()');
  await db.query("UPDATE jobs SET state='cancelled' WHERE state IN ('pending','processing','sending')");
  const clientRow = await db.one('SELECT * FROM clients WHERE id=$1', [
    client.id,
  ]);
  await db.query('DELETE FROM customer_actions WHERE conversation_id=$1', [
    conversation.id,
  ]);
  const outputs = [];
  let calls = 0;
  const worker = createMessageWorker({
    db,
    box,
    config,
    generate: async (args) => {
      calls++;
      assert(args.actionTools.some((t) => t.name === 'prepare_email'));
      assert(
        args.messages.some((m) => m.content.includes('customer@example.com')),
      );
      return {
        text: '',
        proposedAction: {
          name: 'prepare_email',
          arguments: { email: 'customer@example.com' },
        },
        tokens: 20,
        cost: 0,
      };
    },
    send: async ({ text }) => {
      outputs.push(text);
      return { id: randomUUID() };
    },
  });
  async function queue(body) {
    const id = randomUUID();
    await db.query(
      "INSERT INTO jobs(id,meta_id,client_id,conversation_id,body,message_type) VALUES($1,$2,$3,$4,$5,'text')",
      [id, randomUUID(), clientRow.id, conversation.id, body],
    );
    await worker.tick();
    assert.equal(
      (await db.one('SELECT state FROM jobs WHERE id=$1', [id])).state,
      'done',
    );
  }
  await queue('Please send the information to customer@example.com');
  assert.match(outputs.at(-1), /Reply yes/);
  await queue('yes please');
  assert.match(outputs.at(-1), /No Google action was performed/);
  assert.equal(calls, 1);
  await worker.stop();
});

test('crawler obeys robots restrictions and blocks sources from a cancelled in-flight page', async () => {
  const started = await mutate('post', '/clients/' + other.id + '/crawls', {
    url: 'https://example.org/',
    follow: true,
  });
  const crawler = createCrawlWorker({
    db,
    fetchFn: async () => new Response('User-agent: *\nDisallow: /blocked\n'),
    render: async () => ({
      title: 'Rules',
      text: 'Allowed content',
      links: ['https://example.org/blocked'],
    }),
  });
  await crawler.tick();
  await crawler.tick();
  await crawler.stop();
  const run = await db.one('SELECT * FROM crawl_runs WHERE id=$1', [
    started.body.id,
  ]);
  assert.equal(run.completed, 1);
  assert.equal(run.failed, 1);
  assert.match(run.note, /crawl rules/);
  const next = await mutate('post', '/clients/' + other.id + '/crawls', {
    url: 'https://example.net/',
    follow: false,
  });
  const interrupted = createCrawlWorker({
    db,
    fetchFn: async () => new Response('', { status: 404 }),
    render: async () => {
      await mutate(
        'post',
        '/clients/' + other.id + '/crawls/' + next.body.id + '/stop',
        {},
      );
      return { title: 'Stopped', text: 'Should never be saved', links: [] };
    },
  });
  await interrupted.tick();
  await interrupted.stop();
  assert.equal(
    (
      await db.one(
        "SELECT count(*)::int AS n FROM knowledge_sources WHERE client_id=$1 AND origin='https://example.net/'",
        [other.id],
      )
    ).n,
    0,
  );
});
