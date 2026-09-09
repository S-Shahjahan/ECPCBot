# Enhanced Relay setup and verification

## Where to find the features

- **Profile:** Test Meta connection checks the saved token and phone number, and WABA app subscriptions when a WABA ID is saved. It does not send a WhatsApp message or prove the inbound webhook works. Complete a real inbound/outbound test after registering the new number.
- **AI & prompt:** choose a provider, optional base URL and model. Get API token opens the provider's key dashboard; secret keys cannot be fetched back. Fetch models lists available IDs. Test AI connection makes a small paid request. Save changes before testing. Changing the provider or base URL requires entering the intended key again.
- **Business facts:** direct owner-written facts plus the reviewed import library. Files/websites first produce editable extracted text; approval adds it to answers. Exclude or delete stale sources. Facts are not automatically refreshed.
- **AI & prompt → Draft from business facts:** generates a proposed personality from saved facts and relevant approved source passages. Review the draft, choose Use this draft, then save the client. Demo mode produces a labeled template instead of a paid AI draft.
- **Integrations:** connect Google, review exact email content and booking settings, then enable the desired actions.
- **Lead tracker:** mobile numbers and conversations appear automatically after inbound webhook ingestion. Add names, stages and team notes. Download uses current filters across every page, with one CSV row per chat message. Formula-like values are escaped for spreadsheet safety. Data follows conversation retention and deletion.
- **Settings:** expanded master rules; owner-customized rules are preserved. Load expanded rules for review to replace a custom version deliberately. Core application boundaries apply even when shared master rules are disabled. No prompt guarantees perfect resistance to injection.

## Google setup — one OAuth client for Relay

1. Create one Google Cloud project for this Relay installation, and enable the Gmail API and Google Calendar API.
2. Configure Google Auth Platform branding, audience and consent information. Create an OAuth client of type **Web application**.
3. Add the exact authorized redirect URI:

   `https://ecpcbot-production.up.railway.app/api/integrations/google/callback`

4. In the Railway application service, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The database service does not need these variables. Deploy the new variables.
5. Open each business's Relay profile → Integrations → Connect Google. Choose Gmail, Calendar or both. Sign into the account belonging to that business and grant access. Each connection is encrypted separately. Connecting or reconnecting leaves automated actions disabled until the owner reviews and enables them.
6. During Google's Testing mode, add every connecting Google account as a test user. Google commonly limits these offline refresh tokens to seven days when non-basic scopes are requested. For ongoing customer use, publish the consent configuration and complete Google's required verification. The provider's current requirements govern eligibility.
7. Set the exact approved email subject/body, calendar ID (`primary` for the account's primary calendar), IANA time zone, duration, weekdays and hours. Save automation settings. Run Test Google connection; it checks account access and configured calendar availability without sending mail or creating events.

Gmail permission is `gmail.send`; Relay does not read inbox content. Calendar permissions are `calendar.events` and `calendar.freebusy`. The app also requests identity/email scopes to check the connected account. OAuth uses an expiring, single-use state bound to the signed-in admin session and PKCE. Cookies use SameSite=Lax for the OAuth return; authenticated mutations still require CSRF tokens and same-origin checks.

Use a different OAuth client only for a separately deployed Relay installation, a different redirect origin/environment, or deliberate ownership isolation. Ordinary business profiles do not require separate Cloud projects.

Reference: [Google server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Google OAuth refresh-token rules](https://developers.google.com/identity/protocols/oauth2#expiration).

## Customer email and call flows

The assistant helps the customer choose a supported action. Only exact customer commands are eligible; model output, source text and generated drafts cannot execute actions.

- `/email customer@example.com` prepares the owner-approved information email to the specified address.
- `/book 2026-10-12T14:00+05:30 customer@example.com` requests a call at that date/time. Use the actual desired future date. The customer must include the time zone.
- The application echoes the recipient and booking details, then requires `/confirm 123456` using the generated code within 15 minutes. `/cancel 123456` cancels the pending request.

There is a limit of five new requests per customer per day. A new request replaces the customer's pending request. Bookings must be at least one hour ahead and within 90 days, and inside the owner's configured hours. Calendar availability is checked at confirmation. An event and invitation are created only after this succeeds. Appointment confirmation does not create a video meeting link; the business should describe its call method in its facts.

The email body is the exact approved template, never arbitrary model-generated mail or an attached chat transcript. No external send occurs during sandbox tests or demo operation. Paused clients, human-owned conversations, expired WhatsApp windows and lost worker ownership block new external actions. A request already accepted by Google cannot be recalled. Timeouts or interrupted delivery are not retried automatically; the team must check Google and the conversation. Calendar availability checks cannot prevent someone independently creating a conflicting event at the same moment.

## Import and retrieval limits

- One file at a time, maximum 10 MB; PDF, DOCX, legacy DOC, UTF-8 TXT/Markdown/CSV, PNG/JPEG/WebP.
- Text PDFs: up to 80 pages. PDFs requiring OCR: up to 10 pages. Protected, corrupt or overly complex documents are rejected. File extraction runs in a separate process with a 90-second timeout and a bounded JS heap.
- Images/scanned PDFs: local English OCR, with a 20-million-pixel input limit and downscaling. Original uploads never go to an AI provider and are not retained. OCR extracts visible text, not image meaning. Verify names, prices and dates. Other languages can be entered directly as text; multilingual OCR is not included.
- Each source: up to 100,000 extracted characters. Each client: up to 100 sources and one million characters. Large website results may be truncated; the preview shows what will be saved.
- Websites: public static HTTPS HTML/text, at most eight linked pages on the same origin. Crawl rules are respected; private addresses, credential URLs and unsafe redirects are blocked. JavaScript-rendered/private pages need direct text or document import. Crawl failures are shown before approval.
- Search is isolated to approved sources for the selected client. Up to ten text passages are supplied alongside direct facts. This keeps provider context bounded but cannot guarantee that every useful passage is selected. For a large multilingual catalogue or semantic matching, evaluate a multilingual embedding model and vector retrieval later. A separate embedding API is not needed for this release.
- Business sources, personality and prompt history persist until deleted. Chat/contact/action records have 90-day retention; inactive conversation deletion cascades lead details and actions. Downloaded CSV files and provider-held data are outside Relay's retention control.

## Deployment and live verification

The existing Dockerfile includes the new JavaScript/native dependencies through `npm ci`; no desktop Word installation is required. The schema is additive and applied on startup. Keep the existing encryption key unchanged. Reserve sufficient service memory for OCR (start with at least 1 GB and observe actual peak use); one extraction runs at a time per process.

After deploying the latest commit:

1. Confirm `/healthz` and `/readyz` return 200, and the login page/new Lead tracker are present.
2. Save the Meta phone ID/token and AI provider/model/key. Run both connection checks, then Test reply.
3. Import a small PDF, Word document and clear image, and approve the reviewed text. Test a question answered only by an approved source, then exclude that source and verify it is no longer retrieved.
4. Connect Google for a test business, enable an approved email and booking configuration, and test connection. From your own WhatsApp number request/confirm an email to your own email address and a future call. Verify the actual Gmail/Calendar result. Check cancellation and a busy time.
5. Send a WhatsApp message to the registered number. Confirm it appears in Conversations and Lead tracker; test a lead stage update and open the CSV in your spreadsheet app.

Automated tests use fake credentials and mocked external HTTP. They exercise actual local parsing/OCR, PostgreSQL schemas, tenant isolation, CSRF, OAuth state/PKCE, action consent and idempotency, conflict checks, export escaping and existing message delivery behavior. They do not certify live Google/Meta account access or AI prompt behavior. Review actual provider replies against injection, misinformation and sales-quality scenarios before enabling a client.
