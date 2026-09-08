# Launch acceptance checklist

Automated checks cover database and API behavior with simulated external services. The items below need the actual deployed accounts. Record the date, tested client and result for each live check.

## Account and hosting

- [ ] Supabase database connects with verified TLS and the tables exist.
- [ ] Public `anon`/`authenticated` roles cannot query application tables.
- [ ] Production fails to start if encryption/session/admin/database configuration is missing.
- [ ] HTTPS dashboard sign-in works; signed-out requests cannot retrieve client data.
- [ ] Server continues running when nobody is viewing the dashboard.
- [ ] `/readyz` is externally monitored and a controlled outage generates a notification.
- [ ] SMTP handoff notification arrives at the configured inbox.
- [ ] Database backup and a separate restore rehearsal succeed.

## First and second WhatsApp clients

- [ ] GET webhook verification succeeds with the configured verify token.
- [ ] Meta app and WABA subscriptions are correct.
- [ ] A permanent System User token can send through the intended phone number ID.
- [ ] An incoming text reaches the right client profile and gets a real reply.
- [ ] A second number uses a different prompt/key/model without data crossing clients.
- [ ] Replay the same signed event: there is only one response job.
- [ ] Send three separate rapid messages: replies preserve conversation order.
- [ ] Delivery receipts update the conversation's outgoing status.
- [ ] Pause client: inbound messages are logged but receive no automatic reply.
- [ ] Change business facts and save: the next new reply uses the update.
- [ ] Invalid AI credentials produce the configured fallback and an alert.
- [ ] Expired reply window blocks automatic and manual free-form sends.
- [ ] A handoff pauses the bot, flags the inbox, and removes the internal tag.
- [ ] Send a human reply and then resume: subsequent customer messages return to the bot.
- [ ] Restart during processing in a test environment: queued work recovers; uncertain sends are flagged and not blindly repeated.

## Prompt review (human judgment required)

- [ ] English, Hinglish and relevant regional language replies are natural.
- [ ] Typos are understood and short questions get short answers.
- [ ] Prices/hours/services come only from provided facts.
- [ ] Unknown facts trigger clarification/handoff without invented answers.
- [ ] Bot honestly discloses that it is an AI when asked.
- [ ] Requests for system instructions are refused.
- [ ] Angry complaints receive a calm handoff.
- [ ] Booking flow is followed; no unverified booking confirmation is invented.
- [ ] Off-topic requests are redirected.
- [ ] OTP/password/card disclosures are handled without repeating the sensitive value.
- [ ] Client reviews and approves representative replies before activation.

## Privacy and user interface

- [ ] Person deletion removes their contacts, logs, jobs, usage and related alerts.
- [ ] Provider retention settings and client disclosures are agreed.
- [ ] 90-day cleanup has been verified using seeded old data in a disposable environment.
- [ ] Owner can operate login, editor, inbox, confirmations and settings with a keyboard.
- [ ] Layout is checked on mobile, desktop, and with 200% browser zoom.
- [ ] Network failures show understandable messages; no secret values appear in errors.

## Plan coverage

Phases 1–5 are implemented in source, including the multi-client profile system, AI adapters, admin UI, security, durable processing, retention and deployment configuration. Real-provider checkpoints, production deployment, account monitoring/backups and Phase 6 client onboarding remain dependent on your accounts and client review. Post-MVP features from Section 13 are intentionally excluded.
