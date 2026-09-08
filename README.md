# Relay — WhatsApp Studio

A private, single-owner WhatsApp assistant dashboard built from `plan.md.txt`. Node.js / Express, React / TypeScript, and PostgreSQL (Supabase). Includes a persistent local demo, production deployment files, and automated integration tests.

**Start with [START-HERE.md](START-HERE.md)** for the account setup and launch checklist. Live operation requires your database connection, Meta app credentials, AI provider credentials, and a deployed HTTPS server. The local demo does not send external messages or call paid AI APIs.

## Run the local demo

Requires Node.js 22.12+ (Node 24 recommended).

```sh
npm ci
npm run build
npm run demo
```

Open `http://localhost:3000` and choose **Open demo workspace**. Demo sample clients and conversations persist in `.local/database`; encryption keys persist in `.local/demo-keys.json`. Both are ignored by Git. Demo mode binds only to loopback and refuses to run with `NODE_ENV=production`. Never tunnel, publish, or use the demo for real customer data.

## Included

- Client profiles, separate credentials, provider/model choice, prompt editor, shared master rules, business facts, message defaults, handoff controls and kill switches.
- OpenAI-compatible adapters for OpenAI, Gemini, DeepSeek and Z.ai. Models are editable; presets are examples, not a guarantee of current availability.
- One signed webhook, routing by Meta `phone_number_id`, with encrypted per-client app secrets and an optional shared default.
- Durable PostgreSQL inbox, duplicate message protection, ordered processing per conversation, bounded retries, and recovery after a server restart.
- Conversation history, human takeover/resume, manual replies within the customer-service window, delivery receipts and operational alerts.
- Single-password admin login, scrypt verification, persistent sessions, secure cookies, CSRF checks, shared database login attempt limits, security headers and encrypted credentials/contact numbers.
- Prompt sandbox, manual prelaunch scenarios, prompt change history, onboarding checklists, token usage and configurable cost estimates.
- Profile export without secrets, person/client deletion, 90-day record cleanup, database/worker health endpoints, and optional SMTP alerts.

## Production

Copy `.env.example` to `.env` for a private local live setup, or create those variables in Railway/Render. Keep the database password and keys out of chat, Git, and prompts. Use the **PostgreSQL connection string**, not Supabase's publishable key.

```sh
npm ci
npm run build
npm start
```

The server applies the idempotent schema on startup. `npm run db:migrate` runs it separately. Production needs a database owner/migration-capable role. Public Supabase API roles have no table access; all data goes through the authenticated Express API. TLS certificate validation is enabled. Supply the provider CA as `DATABASE_CA` if needed. Do not disable TLS verification to bypass certificate errors. Avoid SSL parameters in `DATABASE_URL` that override `DATABASE_SSL`/`DATABASE_CA`.

Deploy using `Dockerfile` and `railway.json`, or the Render blueprint `render.yaml`. The Render blueprint selects a paid starter service; inspect current pricing in your account before using it. Use an always-running service for message processing and retention. Configure one web replica initially. The database lease prevents two processes processing the inbox simultaneously during deployment overlap.

## Verification

```sh
npm run check
npm audit
```

Tests use PGlite's actual PostgreSQL engine locally, an ephemeral in-memory database, fake credentials, and mocked outbound HTTP. Set `TEST_DATABASE_URL` **only to an empty, disposable PostgreSQL database** to exercise the network PostgreSQL adapter instead; the CI workflow does this using PostgreSQL 16. Never point tests at a live database. Real Meta/Supabase/AI/SMTP verification and a browser accessibility review are separate go-live tasks.

## Project layout

| Path                  | Purpose                                               |
| --------------------- | ----------------------------------------------------- |
| `server/app.js`       | Admin API, sessions, security boundaries              |
| `server/webhook.js`   | Signature verification, routing, durable ingestion    |
| `server/worker.js`    | Inbox processing, recovery, retention and alert email |
| `server/providers.js` | AI and WhatsApp HTTP adapters                         |
| `server/clients.js`   | Profile validation and credential handling            |
| `server/security.js`  | AES-GCM, HMAC and sensitive-data filtering            |
| `server/schema.sql`   | PostgreSQL schema and public-role restrictions        |
| `src/main.tsx`        | Dashboard, editor, inbox, settings and alerts         |
| `src/styles.css`      | Responsive design and component styling               |
| `docs/OPERATIONS.md`  | Monitoring, backups, incidents and recovery           |
| `docs/ACCEPTANCE.md`  | Live launch verification and scope coverage           |

## Design boundaries

- Handoff creates an in-app alert and optional owner email. It does not send an unsolicited WhatsApp message to the handoff number. A person can reply in the dashboard. The configured contact number is available to the AI for sharing.
- The system is reactive and sends text only. Unsupported media receives a request for text. Templates, broadcasts, automatic follow-ups, RAG, flow building and voice recognition remain post-MVP features, as the plan specifies.
- Free-form replies are stopped when 24 hours have elapsed since the customer's most recent message. Pricing, permissions, messaging limits and template policies must be checked in the current Meta account; the plan's historic numerical tiers are not enforced as current policy.
- Provider timeouts have bounded retries. A WhatsApp timeout/5xx or crash during delivery is **uncertain** and requires human review; it is not blindly retried. Exactly-once external delivery cannot be guaranteed by the Graph API.
- A single elected worker processes one message at a time. This favors predictable ordering for the first clients; capacity is bounded by provider latency. Monitor queue depth and measure real traffic before onboarding high-volume clients. Unlimited profiles does not imply unlimited throughput.
- Estimated costs use your per-client USD rates and reported tokens, including completed sandbox requests and generated replies even if a later send fails. Failed provider requests with unreported usage cannot be reconciled here. Provider invoices are authoritative. Deleting a person also removes their usage records.
- Pattern-based redaction blocks common labeled OTP/password/card disclosures. It is not a complete PII detection system, and system prompts cannot guarantee perfect AI behavior. Validate vertical-specific rules and do not use this as an emergency, medical, legal or financial advice service.
- Retention removes old bodies and inactive contact/conversation records after 90 days, along with linked jobs/alerts/usage. Current profiles and prompt history persist until client deletion. Provider copies and database backups follow their own retention settings.
- Historical paused messages stay paused after a bot is reactivated. Only future messages are answered. A kill switch can stop work before delivery starts; a request already accepted by Meta cannot be recalled.

## Reference documentation

- [Google Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [Z.ai chat completion API](https://docs.z.ai/api-reference/llm/chat-completion)
- [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Railway deployment health checks](https://docs.railway.com/deployments/healthchecks)
- [Render blueprint reference](https://render.com/docs/blueprint-spec)

These references informed adapter and deployment choices. Check Meta's current app dashboard and official documentation during onboarding; live account permissions and platform policy cannot be validated using the demo.
