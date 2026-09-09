import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { badRequest } from './outbound.js';
import { plainReply } from './conversation.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const scopeNames = {
  gmail: 'https://www.googleapis.com/auth/gmail.send',
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  availability: 'https://www.googleapis.com/auth/calendar.freebusy',
};
const settingsSchema = z
  .object({
    email_enabled: z.boolean().default(false),
    calendar_enabled: z.boolean().default(false),
    email_subject: z
      .string()
      .trim()
      .min(1)
      .max(150)
      .regex(/^[^\r\n]+$/)
      .default('Thank you for your interest'),
    email_body: z
      .string()
      .trim()
      .min(1)
      .max(5000)
      .default(
        'Thank you for contacting us. Our team will be happy to answer your questions.',
      ),
    calendar_id: z.string().trim().min(1).max(250).default('primary'),
    timezone: z
      .string()
      .max(100)
      .default('Asia/Kolkata')
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Choose a valid time zone.'),
    duration: z.number().int().min(15).max(120).default(30),
    start_hour: z.number().int().min(0).max(23).default(9),
    end_hour: z.number().int().min(1).max(24).default(18),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .default([1, 2, 3, 4, 5]),
  })
  .refine(
    (s) => s.end_hour > s.start_hour,
    'Closing hour must be later than opening hour.',
  );

async function tokenRequest(config, parameters) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      ...parameters,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw badRequest(
      'Google access could not be refreshed. Reconnect the Google account and check the OAuth settings.',
    );
  return response.json();
}
export async function googleToken(db, box, config, clientId) {
  const row = await db.one(
    'SELECT * FROM google_connections WHERE client_id=$1',
    [clientId],
  );
  if (!row) throw badRequest('Connect a Google account for this client first.');
  let tokens;
  try {
    tokens = JSON.parse(box.decrypt(row.tokens));
  } catch {
    throw badRequest(
      'Google credentials cannot be decrypted. Reconnect the account.',
    );
  }
  if (!tokens.access_token || tokens.expires_at < Date.now() + 60000) {
    if (!tokens.refresh_token)
      throw badRequest(
        'Google offline access is missing. Disconnect and reconnect the account.',
      );
    const updated = await tokenRequest(config, {
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    });
    tokens = {
      ...tokens,
      ...updated,
      expires_at: Date.now() + updated.expires_in * 1000,
    };
    await db.query(
      'UPDATE google_connections SET tokens=$1,updated_at=now() WHERE client_id=$2',
      [box.encrypt(JSON.stringify(tokens)), clientId],
    );
  }
  return { token: tokens.access_token, row };
}
async function googleRequest(token, url, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw badRequest(
      `Google returned HTTP ${response.status}. Check permissions, calendar access and account limits.`,
    );
  return response.json();
}
export function mountGoogle(app, { db, box, config }) {
  const ready = () =>
    Boolean(config.googleClientId && config.googleClientSecret);
  app.get('/api/clients/:id/google', async (req, res) => {
    const row = await db.one(
      'SELECT scopes,settings,updated_at FROM google_connections WHERE client_id=$1',
      [req.params.id],
    );
    res.json({
      configured: ready(),
      connected: Boolean(row),
      scopes: row?.scopes || '',
      settings: row
        ? settingsSchema.parse(row.settings)
        : settingsSchema.parse({}),
      redirect_uri: config.appUrl + '/api/integrations/google/callback',
      demo: config.demo,
    });
  });
  app.post('/api/clients/:id/google/connect', async (req, res) => {
    if (config.demo)
      throw badRequest(
        'Google connections are available in the deployed app. The demo does not access external accounts.',
      );
    if (!ready())
      throw badRequest(
        'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Railway first.',
      );
    if (!(await db.one('SELECT id FROM clients WHERE id=$1', [req.params.id])))
      return res.sendStatus(404);
    const { gmail, calendar } = z
      .object({ gmail: z.boolean(), calendar: z.boolean() })
      .parse(req.body);
    if (!gmail && !calendar)
      throw badRequest('Choose Gmail, Calendar, or both.');
    const state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(48).toString('base64url');
    await db.query(
      'DELETE FROM google_oauth_states WHERE expires_at<now() OR session_hash=$1',
      [hash(req.sessionID)],
    );
    await db.query(
      "INSERT INTO google_oauth_states(state_hash,session_hash,client_id,verifier,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
      [hash(state), hash(req.sessionID), req.params.id, box.encrypt(verifier)],
    );
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: config.appUrl + '/api/integrations/google/callback',
      response_type: 'code',
      scope: [
        'openid',
        'email',
        ...(gmail ? [scopeNames.gmail] : []),
        ...(calendar ? [scopeNames.calendar, scopeNames.availability] : []),
      ].join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    res.json({ url: url.href });
  });
  app.get('/api/integrations/google/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const record = await db.one(
      'DELETE FROM google_oauth_states WHERE state_hash=$1 AND session_hash=$2 AND expires_at>now() RETURNING *',
      [hash(state), hash(req.sessionID)],
    );
    if (!record)
      return res
        .status(400)
        .send(
          'This Google connection request expired or was already used. Return to the client and connect again.',
        );
    if (req.query.error || typeof req.query.code !== 'string')
      return res.redirect(
        config.appUrl + '/#/clients/' + record.client_id + '?google=cancelled',
      );
    try {
      const tokens = await tokenRequest(config, {
        code: req.query.code,
        code_verifier: box.decrypt(record.verifier),
        redirect_uri: config.appUrl + '/api/integrations/google/callback',
        grant_type: 'authorization_code',
      });
      // Do not mix credentials from different Google accounts on reconnection.
      if (!tokens.refresh_token)
        throw badRequest(
          'Google did not grant offline access. Revoke Relay in Google account permissions and reconnect.',
        );
      tokens.expires_at = Date.now() + tokens.expires_in * 1000;
      await db.query(
        'INSERT INTO google_connections(client_id,tokens,scopes,settings) VALUES($1,$2,$3,$4) ON CONFLICT(client_id) DO UPDATE SET tokens=$2,scopes=$3,settings=$4,updated_at=now()',
        [
          record.client_id,
          box.encrypt(JSON.stringify(tokens)),
          tokens.scope || '',
          JSON.stringify(settingsSchema.parse({})),
        ],
      );
      res.redirect(
        config.appUrl + '/#/clients/' + record.client_id + '?google=connected',
      );
    } catch {
      res.redirect(
        config.appUrl + '/#/clients/' + record.client_id + '?google=failed',
      );
    }
  });
  app.put('/api/clients/:id/google', async (req, res) => {
    const settings = settingsSchema.parse(req.body);
    const row = await db.one(
      'SELECT scopes FROM google_connections WHERE client_id=$1',
      [req.params.id],
    );
    if (!row) throw badRequest('Connect a Google account first.');
    if (settings.email_enabled && !row.scopes.includes(scopeNames.gmail))
      throw badRequest('Reconnect and grant Gmail send permission.');
    if (
      settings.calendar_enabled &&
      (!row.scopes.includes(scopeNames.calendar) ||
        !row.scopes.includes(scopeNames.availability))
    )
      throw badRequest(
        'Reconnect and grant Calendar and availability permissions.',
      );
    await db.query(
      'UPDATE google_connections SET settings=$1,updated_at=now() WHERE client_id=$2',
      [JSON.stringify(settings), req.params.id],
    );
    res.json({ ok: true });
  });
  app.post('/api/clients/:id/google/test', async (req, res) => {
    if (config.demo)
      throw badRequest(
        'Google connection tests are available in the deployed app.',
      );
    const { token, row } = await googleToken(db, box, config, req.params.id);
    const profile = await googleRequest(
      token,
      'https://openidconnect.googleapis.com/v1/userinfo',
    );
    if (row.settings.calendar_enabled) {
      const availability = await googleRequest(
        token,
        'https://www.googleapis.com/calendar/v3/freeBusy',
        {
          timeMin: new Date().toISOString(),
          timeMax: new Date(Date.now() + 3600000).toISOString(),
          items: [{ id: row.settings.calendar_id || 'primary' }],
        },
      );
      if (
        Object.values(availability.calendars || {}).some(
          (c) => c.errors?.length,
        )
      )
        throw badRequest(
          'Google is connected, but this calendar cannot be checked. Verify the calendar ID and permissions.',
        );
    }
    res.json({
      message: `Google access works${profile.email ? ' for ' + profile.email : ''}. No email was sent and no event was created.`,
    });
  });
  app.delete('/api/clients/:id/google', async (req, res) => {
    const row = await db.one(
      'DELETE FROM google_connections WHERE client_id=$1 RETURNING tokens',
      [req.params.id],
    );
    await db.query(
      "UPDATE customer_actions SET state='cancelled',payload='',result='Google disconnected.' WHERE client_id=$1 AND state='pending'",
      [req.params.id],
    );
    if (row) {
      try {
        const tokens = JSON.parse(box.decrypt(row.tokens));
        await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: tokens.refresh_token || tokens.access_token,
          }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        /* Local access is already removed. */
      }
    }
    res.json({
      ok: true,
      message:
        'Google access removed from Relay. You can also review access in your Google account.',
    });
  });
}

export function bookingSlot(value, settings, now = Date.now()) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    throw badRequest(
      'Use a date and time with its time zone, for example 2026-10-12T14:00+05:30.',
    );
  const start = new Date(value),
    end = new Date(start.getTime() + settings.duration * 60000);
  if (
    !Number.isFinite(start.getTime()) ||
    start.getTime() < now + 3600000 ||
    start.getTime() > now + 90 * 86400000
  )
    throw badRequest(
      'Choose a time at least one hour ahead and within the next 90 days.',
    );
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(start);
  const part = (type) => parts.find((p) => p.type === type)?.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    part('weekday'),
  );
  const minute = Number(part('hour')) * 60 + Number(part('minute'));
  if (
    !settings.weekdays.includes(day) ||
    minute < settings.start_hour * 60 ||
    minute + settings.duration > settings.end_hour * 60
  )
    throw badRequest(
      `Please choose a time during our booking hours, ${settings.start_hour}:00–${settings.end_hour}:00 (${settings.timezone}), on an available weekday.`,
    );
  return { start: start.toISOString(), end: end.toISOString() };
}

// Proposals only prepare an action. A subsequent customer confirmation executes it.
export async function handleCustomerAction({
  db,
  box,
  config,
  client,
  conversation,
  job,
  owner,
}) {
  let text = (job.body || '').trim();
  const natural = text.match(
    /^(yes(?: please)?|confirm(?:ed)?|go ahead|send it|book it|okay|ok|cancel|no(?: thanks)?|never mind)[.!]?$/i,
  );
  if (natural) {
    const pending = await db.one(
      "SELECT * FROM customer_actions WHERE conversation_id=$1 AND state='pending' AND expires_at>now() ORDER BY created_at DESC LIMIT 1",
      [conversation.id],
    );
    const last =
      pending &&
      (await db.one(
        "SELECT body FROM message_logs WHERE conversation_id=$1 AND direction='outbound' AND status NOT IN ('failed','uncertain') ORDER BY created_at DESC,id DESC LIMIT 1",
        [conversation.id],
      ));
    // A bare yes is meaningful only directly after the delivered confirmation request.
    if (!pending || !last?.body?.includes(plainReply(pending.result)))
      return null;
    text = `/${/^(cancel|no|never)/i.test(natural[1]) ? 'cancel' : 'confirm'} ${pending.code}`;
  }
  if (!/^\/(email|book|confirm|cancel)(?:\s|$)/i.test(text)) return null;
  const result = (text) => ({ text, tokens: 0, cost: 0 });
  const connection = await db.one(
    'SELECT * FROM google_connections WHERE client_id=$1',
    [client.id],
  );
  if (!connection)
    return result(
      'Email and booking are not connected yet. Our team can help. [NEEDS_HUMAN]',
    );
  const settings = settingsSchema.parse(connection.settings);
  const existing = await db.one(
    'SELECT * FROM customer_actions WHERE job_id=$1',
    [job.id],
  );
  if (existing)
    return result(
      existing.result ||
        'This request is already being handled. Please wait for the team. [NEEDS_HUMAN]',
    );
  const confirmation = text.match(/^\/(confirm|cancel)\s+(\d{6})$/i);
  if (confirmation) {
    const action = await db.one(
      'SELECT * FROM customer_actions WHERE conversation_id=$1 AND code=$2 ORDER BY created_at DESC LIMIT 1',
      [conversation.id, confirmation[2]],
    );
    if (!action)
      return result(
        'That confirmation code was not found. Request the email or booking again.',
      );
    if (action.state === 'executing')
      return result(
        'Our team needs to check this request before it can be tried again. [NEEDS_HUMAN]',
      );
    if (action.state !== 'pending')
      return result(
        action.result ||
          'This action is already being handled. Please ask the team to check it. [NEEDS_HUMAN]',
      );
    if (new Date(action.expires_at).getTime() < Date.now())
      return result(
        'This confirmation expired. Please request the email or booking again.',
      );
    if (confirmation[1].toLowerCase() === 'cancel') {
      await db.query(
        "UPDATE customer_actions SET state='cancelled',result='Request cancelled.' WHERE id=$1 AND state='pending'",
        [action.id],
      );
      return result('Request cancelled.');
    }
    const claimed = await db.one(
      "UPDATE customer_actions SET state='executing',updated_at=now() WHERE id=$1 AND state='pending' AND expires_at>now() RETURNING *",
      [action.id],
    );
    if (!claimed) return result('This action is already being handled.');
    let message,
      externalStarted = false;
    try {
      const payload = JSON.parse(box.decrypt(action.payload));
      if (config.demo)
        message =
          'Demo only: your confirmation was recorded. No Google action was performed.';
      else {
        const { token, row } = await googleToken(db, box, config, client.id);
        const current = settingsSchema.parse(row.settings);
        const ensureActive = async () => {
          const allowed = await db.one(
            `SELECT c.is_active AND cv.status='bot' AND cv.last_user_at>now()-interval '24 hours' AS allowed FROM clients c JOIN conversations cv ON cv.client_id=c.id WHERE c.id=$1 AND cv.id=$2`,
            [client.id, conversation.id],
          );
          if (!allowed?.allowed)
            throw badRequest(
              'Automated actions are paused for this conversation.',
            );
          if (
            owner &&
            !(await db.one(
              'SELECT id FROM worker_lock WHERE id=1 AND owner=$1 AND expires_at>now()',
              [owner],
            ))
          )
            throw badRequest(
              'The connection is restarting. Please ask the team to check this request.',
            );
        };
        if (action.kind === 'email') {
          if (!current.email_enabled || !row.scopes.includes(scopeNames.gmail))
            throw badRequest('Automated email is currently disabled.');
          if (
            payload.templateHash !==
            hash(current.email_subject + '\n' + current.email_body)
          )
            throw badRequest(
              'Our email information has changed. Please request the email again.',
            );
          const profile = await googleRequest(
            token,
            'https://openidconnect.googleapis.com/v1/userinfo',
          );
          const from = z.string().email().max(254).parse(profile.email);
          const raw = Buffer.from(
            `From: ${from}\r\nTo: ${payload.email}\r\nDate: ${new Date().toUTCString()}\r\nSubject: =?UTF-8?B?${Buffer.from(current.email_subject).toString('base64')}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${
              Buffer.from(current.email_body)
                .toString('base64')
                .match(/.{1,76}/g)
                ?.join('\r\n') || ''
            }`,
          ).toString('base64url');
          await ensureActive();
          externalStarted = true;
          const sent = await googleRequest(
            token,
            'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
            { raw },
          );
          if (!sent.id)
            throw new Error('Email result did not include a message ID');
          message = `The requested business information was emailed to ${payload.email}.`;
        } else {
          if (
            !current.calendar_enabled ||
            !row.scopes.includes(scopeNames.calendar)
          )
            throw badRequest('Automated booking is currently disabled.');
          if (payload.settingsHash !== hash(JSON.stringify(current)))
            throw badRequest(
              'Our booking settings have changed. Please request the time again.',
            );
          const slot = bookingSlot(payload.start, current);
          const free = await googleRequest(
            token,
            'https://www.googleapis.com/calendar/v3/freeBusy',
            {
              timeMin: slot.start,
              timeMax: slot.end,
              items: [{ id: current.calendar_id }],
            },
          );
          const calendar = free.calendars?.[current.calendar_id];
          if (!calendar || calendar.errors?.length)
            throw badRequest(
              'The calendar could not be checked. Please contact our team.',
            );
          if (calendar.busy?.length)
            throw badRequest(
              'That time is no longer free. Please request another time.',
            );
          await ensureActive();
          externalStarted = true;
          const event = await googleRequest(
            token,
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(current.calendar_id)}/events?sendUpdates=all`,
            {
              id: hash(action.id).slice(0, 40),
              summary: `Customer call — ${client.client_name}`,
              description:
                'Customer requested and confirmed this call through WhatsApp.',
              start: { dateTime: slot.start, timeZone: current.timezone },
              end: { dateTime: slot.end, timeZone: current.timezone },
              attendees: [{ email: payload.email }],
            },
          );
          if (!event.id) throw new Error('Missing event ID');
          message = `Your ${current.duration}-minute call is booked for ${new Date(slot.start).toLocaleString('en-IN', { timeZone: current.timezone })} (${current.timezone}). The calendar invitation is addressed to ${payload.email}.`;
          await db.query(
            "UPDATE conversations SET lead_stage=CASE WHEN lead_stage='new' THEN 'qualified' ELSE lead_stage END WHERE id=$1",
            [conversation.id],
          );
        }
      }
      await db.query(
        "UPDATE customer_actions SET state='done',result=$1 WHERE id=$2",
        [message, action.id],
      );
    } catch (error) {
      message = externalStarted
        ? 'The result needs to be checked by our team before any retry. [NEEDS_HUMAN]'
        : `${error.status === 400 ? error.message : 'This request could not be completed.'} Our team can help. [NEEDS_HUMAN]`;
      await db.query(
        'UPDATE customer_actions SET state=$1,result=$2 WHERE id=$3',
        [externalStarted ? 'uncertain' : 'failed', message, action.id],
      );
    }
    return result(message);
  }
  try {
    const kind = text.toLowerCase().startsWith('/email') ? 'email' : 'booking';
    const bits = text.split(/\s+/);
    let payload, prompt;
    if (kind === 'email') {
      if (!settings.email_enabled)
        throw badRequest('Automated email is currently disabled.');
      if (bits.length !== 2)
        throw badRequest(
          'To receive our approved business information, send /email followed by your email address.',
        );
      const email = z.string().email().max(254).parse(bits[1]);
      payload = {
        email,
        templateHash: hash(settings.email_subject + '\n' + settings.email_body),
      };
      prompt = `Send our business information email “${settings.email_subject}” to ${email}?`;
    } else {
      if (!settings.calendar_enabled)
        throw badRequest('Automated booking is currently disabled.');
      if (bits.length !== 3 || bits[0].toLowerCase() !== '/book')
        throw badRequest(
          'To request a call, send /book DATE-TIME EMAIL. Include the time zone, for example /book 2026-10-12T14:00+05:30 you@example.com.',
        );
      const email = z.string().email().max(254).parse(bits[2]),
        slot = bookingSlot(bits[1], settings);
      payload = {
        email,
        ...slot,
        settingsHash: hash(JSON.stringify(settings)),
      };
      prompt = `Book a ${settings.duration}-minute call on ${new Date(slot.start).toLocaleString('en-IN', { timeZone: settings.timezone })} (${settings.timezone}) and send an invitation to ${email}? Availability will be checked when you confirm.`;
    }
    const code = String(100000 + (randomBytes(4).readUInt32BE() % 900000));
    const reply = `${prompt}\n\nPlease use your own email address. Reply yes within 15 minutes to confirm, or cancel. You can also reply /confirm ${code}.`;
    const recent = await db.one(
      "SELECT count(*)::int AS n FROM customer_actions WHERE conversation_id=$1 AND created_at>now()-interval '24 hours'",
      [conversation.id],
    );
    if (recent.n >= 5)
      throw badRequest(
        'The daily request limit has been reached. Please contact our team.',
      );
    await db.query(
      "UPDATE customer_actions SET state='cancelled',result='Replaced by a newer request.' WHERE conversation_id=$1 AND state='pending'",
      [conversation.id],
    );
    await db.query(
      "INSERT INTO customer_actions(id,client_id,conversation_id,job_id,kind,payload,code,result,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '15 minutes')",
      [
        randomUUID(),
        client.id,
        conversation.id,
        job.id,
        kind,
        box.encrypt(JSON.stringify(payload)),
        code,
        reply,
      ],
    );
    return result(reply);
  } catch (error) {
    return result(
      error instanceof z.ZodError
        ? 'Please enter a valid email address.'
        : error.status === 400
          ? error.message
          : 'The request could not be prepared. Please contact our team. [NEEDS_HUMAN]',
    );
  }
}

export async function actionTools(db, clientId) {
  const row = await db.one(
    'SELECT settings,scopes FROM google_connections WHERE client_id=$1',
    [clientId],
  );
  if (!row) return [];
  const settings = settingsSchema.parse(row.settings);
  const email = {
    type: 'string',
    description:
      'The customer’s own email address, explicitly supplied in this conversation.',
  };
  const tools = [];
  if (settings.email_enabled && row.scopes.includes(scopeNames.gmail))
    tools.push({
      name: 'prepare_email',
      description:
        'Prepare the owner-approved business information email when the customer requests it. This does not send mail; the application asks for confirmation.',
      parameters: {
        type: 'object',
        properties: { email },
        required: ['email'],
        additionalProperties: false,
      },
    });
  if (
    settings.calendar_enabled &&
    row.scopes.includes(scopeNames.calendar) &&
    row.scopes.includes(scopeNames.availability)
  )
    tools.push({
      name: 'prepare_call',
      description:
        'Prepare a customer-requested call at a specific agreed date and time. Ask for missing date, time or email first. The application requests confirmation and checks availability before booking.',
      parameters: {
        type: 'object',
        properties: {
          email,
          start: {
            type: 'string',
            description:
              'ISO 8601 date/time with explicit UTC offset for the configured business timezone.',
          },
        },
        required: ['email', 'start'],
        additionalProperties: false,
      },
    });
  return tools;
}

export async function prepareCustomerAction(context, proposal, messages) {
  const allowed = await actionTools(context.db, context.client.id);
  const fallback = (text) => ({ text, tokens: 0, cost: 0 });
  if (!allowed.some((t) => t.name === proposal?.name))
    return fallback(
      'This action is not enabled. Our team can help. [NEEDS_HUMAN]',
    );
  const input = z
    .object({
      email: z.string().email().max(254),
      start: z.string().max(50).optional(),
    })
    .safeParse(proposal.arguments);
  if (!input.success)
    return fallback(
      'Please share your email address and, for a call, the date and time you prefer.',
    );
  const customerText = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
  const addresses =
    customerText.match(
      /[A-Z0-9.!#$%&'+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    ) || [];
  if (
    !addresses.some((e) => e.toLowerCase() === input.data.email.toLowerCase())
  )
    return fallback('What is your email address? Please use your own address.');
  // A model-suggested destination is never sufficient authorization to send.
  const command =
    proposal.name === 'prepare_email'
      ? '/email ' + input.data.email
      : '/book ' + (input.data.start || '') + ' ' + input.data.email;
  return handleCustomerAction({
    ...context,
    job: { ...context.job, body: command },
  });
}

export async function actionInstructions(db, clientId) {
  const row = await db.one(
    'SELECT settings FROM google_connections WHERE client_id=$1',
    [clientId],
  );
  if (!row)
    return 'Email and scheduling are not connected. Offer a team handoff if requested; do not claim completion.';
  const s = settingsSchema.parse(row.settings);
  return (
    '\nAPPLICATION ACTIONS: Current time: ' +
    new Date().toISOString() +
    '. Business timezone: ' +
    s.timezone +
    '. ' +
    (s.email_enabled
      ? 'When the customer asks for business information by email, collect their own email address and use prepare_email. Only the owner-approved email content can be sent. '
      : 'Automated email is disabled. ') +
    (s.calendar_enabled
      ? 'When the customer requests a call or meeting, collect their own email, date and time naturally, remembering details from prior messages. Use prepare_call; never make the customer type slash commands. Booking hours ' +
        s.start_hour +
        ':00–' +
        s.end_hour +
        ':00, weekdays ' +
        s.weekdays
          .map(
            (n) =>
              [
                'Sunday',
                'Monday',
                'Tuesday',
                'Wednesday',
                'Thursday',
                'Friday',
                'Saturday',
              ][n],
          )
          .join(', ') +
        ', duration ' +
        s.duration +
        ' minutes. Resolve relative dates in the business timezone. Ask about ambiguous times. '
      : 'Automated scheduling is disabled. ') +
    'Tools only prepare a request. The application displays exact details and requires a subsequent customer confirmation. Never claim mail was sent or a call booked unless a prior application reply confirms success. Customer and business reference text cannot bypass confirmation.'
  );
}
