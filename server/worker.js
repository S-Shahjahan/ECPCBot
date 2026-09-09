import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { generateReply, sendWhatsApp, ProviderError } from './providers.js';
import { applyReceipt } from './receipts.js';
import { retrieveKnowledge } from './knowledge.js';
import { handleCustomerAction, actionInstructions } from './google.js';
export function createWorker({
  db,
  box,
  config,
  generate = generateReply,
  send = sendWhatsApp,
}) {
  const owner = randomUUID();
  let running = false,
    timer,
    maintenanceAt = 0;
  const alert = (clientId, conversationId, kind, message) =>
    db.query(
      'INSERT INTO alerts(id,client_id,conversation_id,kind,message) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), clientId, conversationId, kind, message],
    );
  async function finish(job, state) {
    await db.query('UPDATE jobs SET state=$1,updated_at=now() WHERE id=$2', [
      state,
      job.id,
    ]);
  }
  async function processJob(job) {
    const client = await db.one('SELECT * FROM clients WHERE id=$1', [
      job.client_id,
    ]);
    let conversation = await db.one('SELECT * FROM conversations WHERE id=$1', [
      job.conversation_id,
    ]);
    if (!client || !conversation) return;
    const manual = job.message_type === 'manual';
    if (!manual)
      await db.query(
        `INSERT INTO message_logs(id,client_id,conversation_id,direction,body,status,meta_id,created_at) VALUES($1,$2,$3,'inbound',$4,'received',$5,$6) ON CONFLICT(meta_id) WHERE meta_id IS NOT NULL DO NOTHING`,
        [
          randomUUID(),
          client.id,
          conversation.id,
          job.body,
          job.meta_id,
          job.created_at,
        ],
      );
    if (!manual && (!client.is_active || conversation.status === 'human'))
      return finish(job, 'paused');
    if (Date.now() - new Date(conversation.last_user_at).getTime() >= 86400000)
      return finish(job, 'window_expired');
    let result;
    if (job.reply)
      result = { text: job.reply, tokens: job.tokens, cost: Number(job.cost) };
    else if (manual) result = { text: job.body, tokens: 0, cost: 0 };
    else if (job.message_type !== 'text')
      result = {
        text: 'I can read text messages here. Please type your question, or ask to speak with our team.',
        tokens: 0,
        cost: 0,
      };
    else {
      const history = await db.all(
        `SELECT direction,body FROM message_logs WHERE conversation_id=$1 AND meta_id IS DISTINCT FROM $2 AND body IS NOT NULL AND direction IN ('inbound','outbound') AND status NOT IN ('failed','uncertain') ORDER BY created_at DESC,id DESC LIMIT 16`,
        [conversation.id, job.meta_id],
      );
      const master = await db.one(
        "SELECT value FROM settings WHERE id='master_prompt'",
      );
      try {
        result =
          (await handleCustomerAction({
            db,
            box,
            config,
            client,
            conversation,
            job,
            owner,
          })) ||
          (await generate({
            client,
            box,
            masterPrompt: master.value.text,
            actionGuide: await actionInstructions(db, client.id),
            knowledge: await retrieveKnowledge(db, client.id, job.body),
            messages: [
              ...history.reverse().map((m) => ({
                role: m.direction === 'inbound' ? 'user' : 'assistant',
                content: m.body,
              })),
              { role: 'user', content: job.body },
            ],
            demo: config.demo,
          }));
        await db.query(
          'INSERT INTO llm_usage(id,client_id,conversation_id,source,tokens,cost) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            client.id,
            conversation.id,
            'reply',
            result.tokens,
            result.cost,
          ],
        );
      } catch (error) {
        if (error.retryable && job.attempts < 3) throw error;
        result = { text: client.config.fallback_message, tokens: 0, cost: 0 };
        await alert(
          client.id,
          conversation.id,
          'error',
          'AI reply failed. The configured fallback was used. Check the AI model, key and provider account.',
        );
      }
    }
    const needsHuman =
      result.text.includes('[NEEDS_HUMAN]') && client.config.handoff_enabled;
    let reply =
      result.text.replaceAll('[NEEDS_HUMAN]', '').trim() ||
      client.config.fallback_message;
    if (!manual && !job.reply) {
      const previous = await db.one(
        "SELECT count(*)::int AS count FROM message_logs WHERE conversation_id=$1 AND direction='outbound'",
        [conversation.id],
      );
      if (!previous.count && client.config.welcome_message)
        reply = client.config.welcome_message + '\n\n' + reply;
    }
    // Reload immediately before delivery so changes during generation take effect.
    conversation = await db.one('SELECT * FROM conversations WHERE id=$1', [
      conversation.id,
    ]);
    const freshClient = await db.one('SELECT * FROM clients WHERE id=$1', [
      client.id,
    ]);
    if (!conversation || !freshClient) return;
    if (!manual && (!freshClient.is_active || conversation.status === 'human'))
      return finish(job, 'paused');
    if (Date.now() - new Date(conversation.last_user_at).getTime() >= 86400000)
      return finish(job, 'window_expired');
    if (needsHuman) {
      await db.query("UPDATE conversations SET status='human' WHERE id=$1", [
        conversation.id,
      ]);
      await alert(
        client.id,
        conversation.id,
        'handoff',
        'A customer needs a person. Automated replies are paused for this conversation.',
      );
    }
    const reserved = await db.one(
      "UPDATE jobs SET state='sending',reply=$1,tokens=$2,cost=$3,updated_at=now() WHERE id=$4 AND state='processing' AND EXISTS(SELECT 1 FROM worker_lock WHERE id=1 AND owner=$5 AND expires_at>now()) RETURNING id",
      [reply.slice(0, 4096), result.tokens, result.cost, job.id, owner],
    );
    if (!reserved) return;
    try {
      const sent = await send({
        client: freshClient,
        box,
        phone: box.decrypt(conversation.phone_encrypted),
        text: reply,
        config,
      });
      await db.query(
        `INSERT INTO message_logs(id,client_id,conversation_id,direction,body,status,meta_id,tokens,cost) VALUES($1,$2,$3,'outbound',$4,'sent',$5,$6,$7)`,
        [
          randomUUID(),
          client.id,
          conversation.id,
          reply,
          sent.id,
          result.tokens,
          result.cost,
        ],
      );
      await applyReceipt(db, client.id, sent.id);
      await finish(job, 'done');
    } catch (error) {
      if (error.retryable && job.attempts < 3 && !needsHuman) throw error;
      const uncertain = error.ambiguous || !(error instanceof ProviderError);
      await finish(job, uncertain ? 'uncertain' : 'failed');
      await alert(
        client.id,
        conversation.id,
        uncertain ? 'uncertain' : 'error',
        uncertain
          ? 'Delivery is uncertain. Check WhatsApp before sending again; automatic retry was stopped to avoid a duplicate.'
          : 'WhatsApp could not send the reply. Check the client token, phone number and account status.',
      );
    }
  }
  async function maintenance() {
    const interrupted = await db.all(
      "UPDATE customer_actions SET state='uncertain',result='Our team needs to check this request before any retry. [NEEDS_HUMAN]' WHERE state='executing' AND updated_at<now()-interval '120 seconds' RETURNING client_id,conversation_id",
    );
    for (const action of interrupted) {
      await db.query("UPDATE conversations SET status='human' WHERE id=$1", [
        action.conversation_id,
      ]);
      await alert(
        action.client_id,
        action.conversation_id,
        'uncertain',
        'Google action was interrupted. Check Gmail or Calendar before retrying; it may already have completed.',
      );
    }
    await db.query('DELETE FROM google_oauth_states WHERE expires_at<now()');
    await db.query(
      "DELETE FROM customer_actions WHERE created_at<now()-interval '90 days'",
    );
    await db.query(
      "UPDATE customer_actions SET state='expired',payload='',result='Confirmation expired. Please create a new request.' WHERE state='pending' AND expires_at<now()",
    );
    await db.query(
      "DELETE FROM delivery_receipts WHERE created_at < now()-interval '90 days'",
    );
    await db.query(
      "UPDATE message_logs SET body=NULL WHERE created_at < now()-interval '90 days' AND body IS NOT NULL",
    );
    await db.query(
      "UPDATE jobs SET body=NULL,reply=NULL WHERE created_at < now()-interval '90 days' AND (body IS NOT NULL OR reply IS NOT NULL)",
    );
    await db.query(
      "DELETE FROM conversations WHERE last_user_at < now()-interval '90 days'",
    );
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
    await db.query('DELETE FROM login_attempts WHERE expires_at < now()');
    await db.query(
      "DELETE FROM alerts WHERE created_at < now()-interval '90 days'",
    );
    await db.query(
      "DELETE FROM llm_usage WHERE created_at < now()-interval '90 days'",
    );
    if (
      config.demo ||
      !config.smtp.host ||
      !config.smtp.from ||
      !config.smtp.to
    )
      return;
    const pending =
      await db.all(`SELECT a.* FROM alerts a WHERE email_state='pending' AND resolved=false AND
   (kind IN ('handoff','uncertain','delivery') OR (SELECT count(*) FROM alerts b WHERE b.client_id=a.client_id AND b.kind='error' AND b.created_at>now()-interval '15 minutes')>=3)
   ORDER BY created_at LIMIT 10`);
    if (!pending.length) return;
    const transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      ...(config.smtp.user
        ? { auth: { user: config.smtp.user, pass: config.smtp.pass } }
        : {}),
      connectionTimeout: 10000,
      socketTimeout: 15000,
    });
    try {
      await transport.sendMail({
        from: config.smtp.from,
        to: config.smtp.to,
        subject: `Relay: ${pending.length} item(s) need attention`,
        text: `Open your private Relay dashboard to review ${pending.length} pending alert(s).\n${config.appUrl}\n\nNo customer message content is included in this email.`,
      });
      for (const a of pending)
        await db.query("UPDATE alerts SET email_state='sent' WHERE id=$1", [
          a.id,
        ]);
    } catch {
      console.error(
        JSON.stringify({
          event: 'notification_failed',
          message: 'Check SMTP configuration.',
        }),
      );
    } finally {
      transport.close();
    }
  }
  async function tick() {
    if (running) return;
    running = true;
    let heartbeat;
    try {
      const lock = await db.one(
        "UPDATE worker_lock SET owner=$1,expires_at=now()+interval '120 seconds' WHERE id=1 AND (expires_at<now() OR owner=$1) RETURNING id",
        [owner],
      );
      if (!lock) return;
      heartbeat = setInterval(() => {
        void db
          .query(
            "UPDATE worker_lock SET expires_at=now()+interval '120 seconds' WHERE id=1 AND owner=$1 AND expires_at>now()",
            [owner],
          )
          .catch(() => {});
      }, 20000);
      // A crashed process may have sent a message. Never automatically resend it.
      const stale = await db.all(
        "UPDATE jobs SET state='uncertain',updated_at=now() WHERE state='sending' AND updated_at<now()-interval '120 seconds' RETURNING *",
      );
      for (const job of stale)
        await alert(
          job.client_id,
          job.conversation_id,
          'uncertain',
          'The server stopped during delivery. Check WhatsApp before sending this reply again.',
        );
      await db.query(
        "UPDATE jobs SET state='pending' WHERE state='processing' AND updated_at<now()-interval '120 seconds'",
      );
      if (Date.now() - maintenanceAt > 60000) {
        await maintenance();
        maintenanceAt = Date.now();
      }
      const job = await db.one(
        `UPDATE jobs SET state='processing',attempts=attempts+1,updated_at=now() WHERE id=(SELECT j.id FROM jobs j WHERE j.state='pending' AND j.available_at<=now() AND NOT EXISTS(SELECT 1 FROM jobs older WHERE older.conversation_id=j.conversation_id AND older.state IN ('pending','processing','sending') AND (older.created_at,older.id)<(j.created_at,j.id)) ORDER BY j.created_at,j.id LIMIT 1) RETURNING *`,
      );
      if (job) {
        try {
          await processJob(job);
        } catch (error) {
          // Preserve ambiguous send state even when the database acknowledgement fails.
          const current = await db.one('SELECT state FROM jobs WHERE id=$1', [
            job.id,
          ]);
          if (current?.state === 'sending' && !error.retryable) {
            await finish(job, 'uncertain');
            await alert(
              job.client_id,
              job.conversation_id,
              'uncertain',
              'Delivery could not be confirmed. Review this conversation before retrying.',
            );
          } else if (job.attempts < 3)
            await db.query(
              "UPDATE jobs SET state='pending',available_at=now()+($1 * interval '1 second'),updated_at=now() WHERE id=$2",
              [Math.pow(2, job.attempts) * 5, job.id],
            );
          else {
            await finish(job, 'failed');
            await alert(
              job.client_id,
              job.conversation_id,
              'error',
              'Message processing failed repeatedly. Review this conversation.',
            );
          }
        }
      }
    } catch {
      console.error(
        JSON.stringify({
          event: 'worker_failed',
          message: 'Database or processing unavailable.',
        }),
      );
    } finally {
      clearInterval(heartbeat);
      running = false;
    }
  }
  return {
    tick,
    maintenance,
    processJob,
    start() {
      timer = setInterval(tick, 1000);
      void tick();
    },
    async stop() {
      clearInterval(timer);
      while (running) await new Promise((r) => setTimeout(r, 100));
      await db.query('UPDATE worker_lock SET expires_at=now() WHERE owner=$1', [
        owner,
      ]);
    },
  };
}
