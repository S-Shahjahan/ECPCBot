# Enhanced Relay setup and verification

## Where to find the features

- **Profile:** Test Meta connection checks the saved token and phone number, and WABA app subscriptions when a WABA ID is saved. It does not send a WhatsApp message or prove the inbound webhook works. Complete a real inbound/outbound test after registering the new number.
- **AI & prompt:** choose Provider → editable prefilled Base URL → API key → automatically fetched Model → Test API → Save. Discovery and testing use the unsaved values without changing saved credentials. Get API token opens the provider’s key dashboard. Changing the provider or endpoint requires entering the intended key again.
- **Business facts:** direct owner-written facts plus the reviewed import library. Files/websites first produce editable extracted text; approval adds it to answers. Exclude or delete stale sources. Facts are not automatically refreshed.
- **AI & prompt → Draft from business facts:** creates a behavior draft referencing the approved library without inventing prices, services or delivery promises. Review the draft, choose Use this draft, then save the client. Drafting does not incur an AI call; factual information stays in Business facts.
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
7. Set the exact approved email subject/body, calendar ID (`primary` for the account's primary calendar), IANA time zone, duration, weekdays and hours. Save automation settings. Run Test Google connection; it explicitly refreshes offline access, reports granted capabilities and enabled automations, and checks configured calendar availability without sending mail or creating events. Sign-in-only grants are shown as incomplete. Grant the requested Gmail/Calendar permissions on Google’s consent screen; connecting alone does not enable automation.

Gmail permission is `gmail.send`; Relay does not read inbox content. Calendar permissions are `calendar.events` and `calendar.freebusy`. The app also requests identity/email scopes to check the connected account. OAuth uses an expiring, single-use state bound to the signed-in admin session and PKCE. Cookies use SameSite=Lax for the OAuth return; authenticated mutations still require CSRF tokens and same-origin checks.

Use a different OAuth client only for a separately deployed Relay installation, a different redirect origin/environment, or deliberate ownership isolation. Ordinary business profiles do not require separate Cloud projects.

Reference: [Google server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Google OAuth refresh-token rules](https://developers.google.com/identity/protocols/oauth2#expiration).

## Customer email and call flows

The assistant collects the customer’s email, and the desired date/time for a call, through ordinary conversation. Model tools prepare a request; they cannot send or book directly. The recipient must have appeared in customer messages.

- Ask “Please email me the details at my-address@example.com” or “Can we arrange a call tomorrow afternoon?” The assistant asks for missing details and uses the configured business timezone.
- The application echoes the exact recipient and date/time, then accepts “yes”, “yes please” or “go ahead” within 15 minutes. A natural confirmation is accepted only immediately after a successfully delivered confirmation request. “Cancel” cancels the pending request.
- Existing `/email`, `/book`, `/confirm CODE` and `/cancel CODE` commands remain supported. A model with function-calling support is required for conversational preparation; use Test API and a playground request to check the selected model.

There is a limit of five new requests per customer per day. A new request replaces the customer's pending request. Bookings must be at least one hour ahead and within 90 days, and inside the owner's configured hours. Calendar availability is checked at confirmation. An event and invitation are created only after this succeeds. Appointment confirmation does not create a video meeting link; the business should describe its call method in its facts.

An information email uses the exact owner-approved template. A catalogue quotation email includes the application-verified product, quantity, size, sides, GSM and price, followed by the approved email text. The confirmation shows the quote and recipient before sending; the approved source and template are rechecked for changes at confirmation. Arbitrary model-generated mail and chat transcripts are not sent. Google failures are recorded as admin alerts; customers receive a brief failure/handoff message rather than OAuth errors. A successful API send is not proof of inbox delivery. No external send occurs during sandbox tests or demo operation. Paused clients, human-owned conversations, expired WhatsApp windows and lost worker ownership block new external actions. A request already accepted by Google cannot be recalled. Timeouts or interrupted delivery are not retried automatically; the team must check Google and the conversation. Calendar availability checks cannot prevent someone independently creating a conflicting event at the same moment.

Chat replies now include early preferences plus recent conversation history within a bounded context budget. The playground keeps a multi-turn test conversation until New test conversation is selected. Customer replies are instructed and normalized to plain text. Both channels use the same reply builder and mandatory scope/privacy/factuality rules; they keep separate conversation histories, so exact wording need not be identical. Generated customer answers receive a second model review against approved facts, with a safe fallback when review fails. This adds provider latency and token use (included in usage estimates); it is an additional guardrail, not proof against every possible model error. Exact catalogue quote replies are computed without a model. Printing catalogues need Product (or product_name), Qty, Side, Size, Paper GSM and Price columns; other document formats remain available through ordinary grounded retrieval.

## Import and retrieval limits

- One file at a time, maximum 10 MB; PDF, DOCX, legacy DOC, XLS/XLSX, PPT/PPTX, UTF-8 TXT/Markdown/CSV, PNG/JPEG/WebP. Every worksheet in Excel is imported, including hidden worksheets, with sheet names and row labels preserved. Review hidden content before approval. Spreadsheets use displayed/cached cell values; formulas are never executed. Presentation images/charts are not automatically transcribed; review extracted slide text.
- Text PDFs: up to 80 pages. PDFs requiring OCR: up to 10 pages. Protected, corrupt or overly complex documents are rejected. File extraction runs in a separate process with a 90-second timeout and a bounded JS heap.
- Images/scanned PDFs: local English OCR, with a 20-million-pixel input limit and downscaling. Original uploads never go to an AI provider and are not retained. OCR extracts visible text, not image meaning. Verify names, prices and dates. Other languages can be entered directly as text; multilingual OCR is not included.
- Each file/source: up to 100,000 extracted characters. Website pages are saved individually, with an explicit warning for a page exceeding this size. There is no fixed page-count or library source-count limit; storage use grows with the library.
- Websites: public HTTPS pages, including JavaScript-rendered content. Entire-site crawling follows same-origin links without a fixed page-count limit. A durable background queue survives restarts and supports Stop/Resume. Each page becomes an unapproved library source; review and approve it before use. Website crawl rules and delays are respected. Private addresses, credential URLs, cross-origin navigations and non-GET requests are blocked. Rendering has per-page time, request and byte limits; individual failures are reported. Login-protected sites and content requiring form submissions need direct import.
- Search is isolated to approved sources for the selected client. Every question uses PostgreSQL full-text ranking across all approved source chunks and Excel worksheets. Only the best matching passages are supplied to the AI, with a 3,500-character evidence budget; the entire library is never copied into an ordinary prompt. Direct facts and conversation history have separate limits. Common business synonyms improve ordinary phrasing without an embedding call. The catalogue quotation path scans all approved pricing sources and answers exact matches without an AI call. Keyword retrieval cannot guarantee a semantic match for every paraphrase or language, so evaluate embeddings later only if measured test questions expose that gap.
- Token use is visible per generated reply and as a cumulative total for each conversation. The client list shows this month's usage as a comparative meter and the client's lifetime total. Sandbox tests count toward the workspace overview and client totals but do not belong to a customer conversation.
- Business sources, personality and prompt history persist until deleted. Chat/contact/action records have 90-day retention; inactive conversation deletion cascades lead details and actions. Downloaded CSV files and provider-held data are outside Relay's retention control.

## Deployment and live verification

The Dockerfile installs Chromium and its Linux dependencies as well as file readers. No desktop Office installation is required. Railway must build the supplied Dockerfile so browser dependencies are present. The schema is additive and applied on startup. Keep the existing encryption key unchanged. Reserve sufficient service memory for OCR (start with at least 1 GB and observe actual peak use); one extraction runs at a time per process.

After deploying the latest commit:

1. Confirm `/healthz` and `/readyz` return 200, and the login page/new Lead tracker are present.
2. Save the Meta phone ID/token and AI provider/model/key. Run both connection checks, then Test reply.
3. Import a small PDF, Word document, a multi-worksheet Excel workbook and clear image, and approve the reviewed text. Test a question answered only by an approved source, then exclude that source and verify it is no longer retrieved.
4. Connect Google for a test business, enable an approved email and booking configuration, and test connection. From your own WhatsApp number request/confirm an email to your own email address and a future call. Verify the actual Gmail/Calendar result. Check cancellation and a busy time.
5. Send a WhatsApp message to the registered number. Confirm it appears in Conversations and Lead tracker; test a lead stage update and open the CSV in your spreadsheet app.
6. In the same conversation, ask for an unrelated fact and model identity; expect redirection without a trivia answer or provider name. Request a brochure quote with quantity/sides/GSM but omit size; expect a size question, not an A4 assumption or an email request. Specify size, request the verified quote by email, confirm, and verify the actual received content. Repeat after changing or excluding its catalogue source; stale quotes must not send.

Automated tests use fake credentials and mocked external HTTP. They exercise actual local parsing/OCR, PostgreSQL schemas, tenant isolation, CSRF, OAuth state/PKCE, action consent and idempotency, conflict checks, export escaping and existing message delivery behavior. They do not certify live Google/Meta account access or AI prompt behavior. Review actual provider replies against injection, misinformation and sales-quality scenarios before enabling a client.
