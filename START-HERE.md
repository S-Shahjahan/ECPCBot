# Your Relay launch guide

The application is built. You can explore it locally immediately. Taking it live requires connecting accounts you control; there is no need to send secret keys in chat.

## What you can do in parallel

| Action                      | Where                                          | Finished when                                                                                 |
| --------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Create the database         | Supabase → project → Connect                   | You have the PostgreSQL connection string and database password                               |
| Prepare WhatsApp            | Meta developer dashboard → your app → WhatsApp | You have a test number, phone number ID, app secret and test recipient                        |
| Prepare the AI account      | Your selected provider                         | API access is enabled and a funded/eligible model can answer a test                           |
| Choose hosting              | Railway or Render                              | GitHub repository is connected to an always-running web service                               |
| Prepare email notifications | An SMTP provider                               | SMTP host, port, username, password and sender/recipient are ready                            |
| Gather client facts         | Client owner                                   | Business name, hours, prices, booking flow, FAQs, contact, never-say list and tone are agreed |

Your supplied repository is `https://github.com/S-Shahjahan/ECPCBot`. The app uses a server-side database connection. The Supabase publishable key you supplied is not needed by this implementation.

## 1. Explore locally

Open a terminal in this folder and run:

```sh
npm ci
npm run build
npm run demo
```

Open `http://localhost:3000`. Select **Open demo workspace**. Try editing a client, saving business facts, previewing an answer, taking over a conversation and changing shared master rules. The demo does not call real AI or send WhatsApp messages. Do not put live credentials in demo profiles; enter them again in the deployed workspace.

## 2. Set private server variables

Use `.env.example` as the checklist. Put values in your host's private environment settings. For local live testing, use a `.env` file (Git ignores it).

- `DATABASE_URL`: use the Supabase PostgreSQL connection string from **Connect**. A session pooler is a convenient choice where direct IPv6 connectivity is unavailable. Use the database password, not a Supabase publishable API key. Percent-encode special password characters when constructing a URL.
- `APP_URL`: your final HTTPS address, without a trailing slash.
- `ADMIN_PASSWORD`: a unique password of at least 16 characters, stored in your password manager.
- `ENCRYPTION_KEY`: a 64-character hex key. Generate locally with the command below; store it in the host and in a separate secure backup. Losing it makes saved credentials and contact numbers unreadable.
- `SESSION_SECRET`: a separate random value of at least 32 characters.
- `WEBHOOK_VERIFY_TOKEN`: a separate random value of at least 24 characters. You choose it and enter the same value in Meta.
- `META_APP_SECRET`: shared Meta app secret. You may instead set a different encrypted app secret inside each client profile.
- `META_GRAPH_VERSION`: the supported API version used by your Meta app. The sample value is configurable; verify it before launch.
- `TRUST_PROXY=1`: for a host with one trusted reverse proxy. The app should not be directly reachable behind an untrusted or different proxy chain.
- `DATABASE_SSL=true`: keep database TLS enabled. If your project requires a custom CA, set `DATABASE_CA` to that PEM certificate.

Generate a new secret locally each time you run:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Do not reuse the encryption key as a session secret. Do not copy the demo keys into production.

## 3. Deploy

**Railway:** create a project from your GitHub repository. The included Docker and Railway configuration builds the dashboard and starts Express. Add the private variables, enable a public domain, set `APP_URL` to that domain, and redeploy. Use `/readyz` for readiness checks. Disable server sleeping for this service.

**Render:** create a service from the included blueprint, enter the requested variables and review the selected starter plan before confirming. The Docker build runs the dashboard and Express together. Add any optional SMTP variables to the service settings. Set the service's final HTTPS address as `APP_URL`.

The database schema is created automatically at startup. Confirm the log reports that Relay is running, `/healthz` returns `ok`, and `/readyz` returns `ready`. The latter can take up to two minutes during a deployment while the previous worker lease expires.

## 4. Connect the first client

1. Sign in with your admin password and choose **Add client**.
2. Enter the business name, WhatsApp **phone number ID** and optional WABA ID.
3. Paste the permanent System User token and the Meta app secret into their dedicated credential fields. Save. Use a test token only for development.
4. Choose the AI provider, enter its current model ID and API key, and save.
5. Enter business facts, booking instructions, tone and any client-specific restrictions. Keep shared master rules enabled unless you have a reason to replace them.
6. Set welcome/fallback messages, human handoff and the contact number.
7. In Meta, use `https://YOUR-HOST/webhook` as the callback URL. Enter the same `WEBHOOK_VERIFY_TOKEN` used by the server. Subscribe to the **messages** field and subscribe the app to the appropriate WABA.
8. If clients use different Meta apps, use the same callback URL and server verify token for each; enter each app's own signing secret in its client profile. The verification token and app secret are different values.
9. Register your test recipient in Meta where required. Try the prompt scenarios, then activate and send an actual WhatsApp message from your phone.
10. Test a second profile to confirm routing. Get the client's review and complete the launch checklist.

## 5. Enable operations before accepting real customers

- Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `ALERT_FROM` and `ALERT_TO`. In-app alerts work without email. Handoffs and uncertain delivery email promptly; repeated AI/WhatsApp failures email after three errors for a client in 15 minutes.
- Add external monitoring for `/readyz` and verify the notification reaches you. Hosting health checks alone are not a complete uptime monitor.
- Enable database backups in Supabase and check actual availability/retention in your plan. Do not assume a free project includes the backups you need. Test recovery into a separate database.
- Agree with each client on stored data, third-party AI processing, contact details and deletion requests. Set provider retention controls where available. No universal zero-retention guarantee is implied.
- Complete `docs/ACCEPTANCE.md`. Review the first week's conversations daily.

## What remains account-dependent

The demo and automated checks cannot prove live WhatsApp delivery, the model's real reply quality, SMTP delivery, host configuration, database backup recovery, or compliance with Meta's current account eligibility requirements. Complete those checks before calling a client live.
