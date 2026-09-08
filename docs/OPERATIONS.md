# Operating Relay

## Health and alerts

- `/healthz`: HTTP 200 if the web server can query the database; 503 otherwise.
- `/readyz`: HTTP 200 if a worker holds a live database lease; 503 otherwise. The check is intentionally reachable by internal HTTP health probes and contains no credentials or customer data. All production dashboard and webhook traffic still requires HTTPS.
- Dashboard **Needs attention**: handoffs, delivery failures and uncertain outcomes. Resolving an alert does not resume a paused conversation. Use **Resume assistant** in that conversation.
- SMTP batches up to ten pending alerts per minute. Handoffs, uncertain delivery and delivery-receipt failures are eligible immediately; ordinary processing errors require three failures in 15 minutes for that client. Email contains a dashboard link, never customer message content. SMTP errors leave alerts pending for another attempt.
- Check queue depth and oldest pending work when a client reports delays. The first version has one active worker across all replicas, intentionally serializing work. Add capacity only after measuring realistic traffic; multi-worker queue partitioning requires an architectural change.

## Daily / weekly

Daily for the first month: message each live bot, scan handoffs and errors, confirm customer questions are answered accurately and that current tokens work. Review the first real client daily for one week.

Weekly: review provider usage/invoices, configured token prices, Meta quality/account status, backup completion and alert delivery. Export non-secret client profiles from Settings and store them privately. Record prompt changes with a reason.

## If a bot is silent

1. Open `/readyz`. A 503 indicates database or worker readiness trouble. Check host startup logs and availability; keep the service awake.
2. Confirm the client is active and the conversation is not in human handling.
3. Confirm Meta webhook verification, messages subscription, WABA subscription, matching phone number ID, app secret and permanent access token.
4. Run the client's prompt test. Check provider model availability, API key, balance and limits.
5. Open the customer's conversation and review job/delivery status. An expired window requires a new customer message. An uncertain send requires checking WhatsApp before sending another reply.
6. If requests are being rejected with 403, confirm the app secret used for signing. Do not disable signature verification.

## Recovery semantics

Meta receives HTTP 200 only after recognized inbound messages have been persisted to the durable inbox. Database failures return 5xx so Meta can retry. Known duplicate message IDs do not create another job. Unsupported/unknown phone profiles are not processed.

A worker lease lasts two minutes and is renewed between processing cycles. Processing jobs abandoned by a crashed worker are eligible for recovery after two minutes. A job marked `sending` when a crash occurs becomes `uncertain`; no automatic resend occurs. This handles the ambiguity between an external delivery and local acknowledgement.

AI/network retries use increasing delays and stop after three attempts. Permanent AI failures send the configured fallback. Rate-limited WhatsApp responses may retry when safe; 5xx/timeouts are treated as uncertain because the external side effect may already have happened. Outbound delivery receipts may subsequently report sent/delivered/read/failed.

Retained uncertain replies can be inspected in the database `jobs.reply` for operational recovery. Review the real WhatsApp thread, then send a manual response only if needed and within the reply window. Never mass-reset all failed/sending jobs to pending.

## Backups and restoring

Use Supabase-managed database backups appropriate to your plan; verify both availability and restore procedures in your account. Secure the encryption key separately. A profile export intentionally omits credentials and is not a full recovery backup.

To rehearse recovery: provision a separate empty PostgreSQL database; restore the backup there using your provider's process; deploy a separate private instance with the backed-up encryption key and a new session secret; leave WhatsApp webhook routing disconnected until reviewed. Confirm profiles and historical encrypted credentials can be read through the app without displaying secrets. Verify restore age and operational alerts, then retire the rehearsal instance.

Restoring an old backup may resurrect data already deleted by customers. Maintain deletion-request records outside this system with minimal identifiers, and reapply required deletions before reconnecting production. Backups and provider-retained data must have a separate deletion/retention process.

## Secret rotation

WhatsApp/AI/app secrets: paste the replacement into the client's credential field and save. Blank fields preserve current values. Confirm a real test succeeds before revoking an old credential when overlap is supported. Rotate a shared Meta secret on the host if it is not overridden in the client profile.

Admin password: update the host variable. Rotate `SESSION_SECRET` too to invalidate existing sessions. Redeploy and sign in again.

Encryption key: **do not replace it directly**; existing AES-GCM records will become unreadable. Keep it safe and prepare an offline decrypt/re-encrypt migration with both keys and a backup if rotation is needed. No automatic key rotation is included.

## Privacy

Incoming message bodies are redacted for common labeled OTP/password/card patterns before storage and AI submission. This is heuristic, not complete sensitive-data detection. The master prompt also refuses sensitive-data collection. Do not put client credentials in prompts or business facts.

The owner can see an individual customer's decrypted phone number inside the conversation so they can provide service. Contact lists show masked numbers. Secrets and ciphertext are excluded from normal list/detail responses. Customer text never appears in server error logs or alert email.

The maintenance job removes old bodies, inactive conversations/contact numbers and linked logs/jobs/alerts/usage after 90 days. It runs every minute while the worker is alive; an outage delays cleanup until processing resumes. Deletion removes live database records, not external provider copies or immutable backups.

## Deployment / rollback

Run the included checks before deployment. Keep the previous known-good image/commit. The initial schema is additive/idempotent; future destructive migrations need a backup and explicit migration review. Roll back source using your host's deployment history, and confirm schema compatibility first. Never roll back by discarding live database data.

Graceful shutdown stops accepting new connections, waits for current processing, and releases the worker lease. A forced host termination falls back to the durable recovery behavior above.
