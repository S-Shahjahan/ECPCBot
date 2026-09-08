import { randomUUID } from 'node:crypto';
import { verifySignature, safeEqual, redact } from './security.js';
import { applyReceipt, deliveryRank } from './receipts.js';
export function mountWebhook(app, { db, box, config }) {
  app.get('/webhook', (req, res) => {
    if (
      req.query['hub.mode'] === 'subscribe' &&
      safeEqual(
        String(req.query['hub.verify_token'] || ''),
        config.verifyToken,
      ) &&
      typeof req.query['hub.challenge'] === 'string'
    )
      return res.type('text').send(req.query['hub.challenge']);
    res.sendStatus(403);
  });
  app.post('/webhook', async (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.sendStatus(400);
    if (!/^sha256=[a-f0-9]{64}$/.test(req.get('x-hub-signature-256') || ''))
      return res.sendStatus(403);
    let payload;
    try {
      payload = JSON.parse(req.body.toString());
    } catch {
      return res.sendStatus(400);
    }
    if (
      !payload ||
      payload.object !== 'whatsapp_business_account' ||
      !Array.isArray(payload.entry)
    )
      return res.sendStatus(400);
    if (payload.entry.some((e) => !e || !Array.isArray(e.changes)))
      return res.sendStatus(400);
    const changes = (payload.entry || [])
      .flatMap((e) => e.changes || [])
      .filter((c) => c?.field === 'messages');
    const routed = [];
    for (const change of changes) {
      const value = change.value || {};
      if (
        (value.messages && !Array.isArray(value.messages)) ||
        (value.statuses && !Array.isArray(value.statuses))
      )
        return res.sendStatus(400);
      const phoneId = value.metadata?.phone_number_id;
      const client = phoneId
        ? await db.one('SELECT * FROM clients WHERE phone_number_id=$1', [
            String(phoneId),
          ])
        : null;
      const secret = client?.secrets.meta_app_secret
        ? box.decrypt(client.secrets.meta_app_secret)
        : config.metaSecret;
      if (!verifySignature(req.body, req.get('x-hub-signature-256'), secret))
        return res.sendStatus(403);
      if (client) routed.push({ client, value });
    }
    if (
      !changes.length &&
      !verifySignature(
        req.body,
        req.get('x-hub-signature-256'),
        config.metaSecret,
      )
    )
      return res.sendStatus(403);
    for (const { client, value } of routed) {
      for (const status of value.statuses || []) {
        if (!status || typeof status.id !== 'string') continue;
        if (deliveryRank[status.status]) {
          await db.query(
            'INSERT INTO delivery_receipts(meta_id,client_id,status,rank) VALUES($1,$2,$3,$4) ON CONFLICT(meta_id) DO UPDATE SET status=EXCLUDED.status,rank=EXCLUDED.rank WHERE delivery_receipts.client_id=EXCLUDED.client_id AND delivery_receipts.rank<EXCLUDED.rank',
            [status.id, client.id, status.status, deliveryRank[status.status]],
          );
          await applyReceipt(db, client.id, status.id);
        }
      }
      for (const message of value.messages || []) {
        if (
          !message ||
          typeof message.id !== 'string' ||
          message.id.length > 512 ||
          !/^\d{7,15}$/.test(message.from || '')
        )
          continue;
        const timestamp = Number(message.timestamp) * 1000;
        if (
          !Number.isFinite(timestamp) ||
          timestamp > Date.now() + 300000 ||
          timestamp < Date.now() - 7 * 86400000
        )
          continue;
        const existing = await db.one('SELECT id FROM jobs WHERE meta_id=$1', [
          message.id,
        ]);
        if (existing) continue;
        const phoneHash = box.phoneHash(message.from);
        const conversation = await db.one(
          `INSERT INTO conversations(id,client_id,phone_hash,phone_encrypted,phone_label,last_user_at) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(client_id,phone_hash) DO UPDATE SET last_user_at=GREATEST(conversations.last_user_at,EXCLUDED.last_user_at) RETURNING *`,
          [
            randomUUID(),
            client.id,
            phoneHash,
            box.encrypt(message.from),
            '•••• ' + message.from.slice(-4),
            new Date(timestamp),
          ],
        );
        const text =
          message.type === 'text'
            ? redact(String(message.text?.body || '').slice(0, 10000))
            : '[Unsupported ' +
              String(message.type || 'message')
                .replace(/[^a-z]/g, '')
                .slice(0, 30) +
              ']';
        // The durable inbox is the acknowledgement boundary. Logs are derived by the worker.
        await db.query(
          'INSERT INTO jobs(id,meta_id,client_id,conversation_id,body,message_type,state) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(meta_id) DO NOTHING',
          [
            randomUUID(),
            String(message.id),
            client.id,
            conversation.id,
            text,
            message.type || 'unknown',
            'pending',
          ],
        );
      }
    }
    res.sendStatus(200);
  });
}
