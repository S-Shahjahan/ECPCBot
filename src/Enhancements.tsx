import { useEffect, useState, useRef, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  Check,
  FileText,
  Globe2,
  LoaderCircle,
  Plug,
  RefreshCw,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
type Obj = Record<string, any>;
type Api = (path: string, method?: string, body?: any) => Promise<any>;
const errorText = (e: any) => e.message || 'Please try again.';
function Result({
  message,
  error = false,
}: {
  message: string;
  error?: boolean;
}) {
  return message ? (
    <div
      className={error ? 'error' : 'notice subtle'}
      role={error ? 'alert' : 'status'}
    >
      {message}
    </div>
  ) : null;
}

export function ConnectionTest({
  id,
  dirty,
  kind,
  api,
}: {
  id: string | null;
  dirty: boolean;
  kind: 'meta' | 'ai';
  api: Api;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState(false);
  return (
    <div className="feature-block compact">
      <button
        type="button"
        className="button secondary"
        disabled={!id || dirty || busy}
        onClick={async () => {
          setBusy(true);
          setMessage('');
          try {
            const result = await api(`/clients/${id}/${kind}-test`, 'POST');
            setError(false);
            setMessage(result.message);
          } catch (e) {
            setError(true);
            setMessage(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <Plug size={16} />
        )}{' '}
        Test {kind === 'meta' ? 'Meta' : 'AI'} connection
      </button>
      <small>
        {dirty || !id
          ? 'Save this profile before testing.'
          : kind === 'meta'
            ? 'Checks token and phone access without sending a message.'
            : 'Makes a small request to the saved model; provider charges may apply.'}
      </small>
      <Result message={message} error={error} />
    </div>
  );
}

export function ProviderTools({
  id,
  dirty,
  form,
  set,
  api,
}: {
  id: string | null;
  dirty: boolean;
  form: Obj;
  set: (key: string, value: any) => void;
  api: Api;
}) {
  const [options, setOptions] = useState<Obj>({}),
    [models, setModels] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    api('/provider-options')
      .then(setOptions)
      .catch((e) => setError(errorText(e)));
  }, [api]);
  useEffect(() => {
    setModels([]);
    setError('');
  }, [form.llm_provider, form.llm_base_url]);
  const provider = options[form.llm_provider] || {};
  return (
    <div className="feature-block">
      <label className="field">
        <span className="field-title">Base URL</span>
        <input
          type="url"
          value={form.llm_base_url || ''}
          placeholder={provider.baseUrl || 'https://your-provider.example/v1'}
          onChange={(e) => set('llm_base_url', e.target.value)}
        />
        <small>
          Leave blank for the provider default. Custom endpoints must support
          {form.llm_provider === 'anthropic'
            ? ' the Anthropic Messages API.'
            : ' OpenAI chat completions.'}{' '}
          Re-enter the key when changing the provider or address.
        </small>
      </label>
      <div className="feature-actions">
        {provider.keyUrl ? (
          <a
            className="button secondary"
            href={provider.keyUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ArrowDownToLine size={15} /> Get API token
          </a>
        ) : (
          <small>
            Get your secret API key from your provider’s account dashboard.
          </small>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={!id || dirty || busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const data = await api(`/clients/${id}/models`, 'POST');
              setModels(data.models);
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <RefreshCw size={15} />
          )}{' '}
          Fetch models
        </button>
      </div>
      <small>
        Providers issue secret tokens in their own dashboards. Existing secret
        keys cannot be fetched back into Relay.
      </small>
      {models.length > 0 && (
        <label className="field">
          <span className="field-title">Available models</span>
          <select
            value={models.includes(form.llm_model) ? form.llm_model : ''}
            onChange={(e) => set('llm_model', e.target.value)}
          >
            <option value="" disabled>
              Select a model
            </option>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <small>
            Discovery lists account models; use Test AI connection to check chat
            compatibility.
          </small>
        </label>
      )}
      <Result message={error} error />
      <ConnectionTest id={id} dirty={dirty} kind="ai" api={api} />
    </div>
  );
}

export function PersonalityDraft({
  id,
  dirty,
  api,
  onUse,
}: {
  id: string | null;
  dirty: boolean;
  api: Api;
  onUse: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [draft, setDraft] = useState(''),
    [error, setError] = useState(''),
    [demo, setDemo] = useState(false);
  return (
    <div className="feature-block">
      <button
        type="button"
        className="button secondary"
        disabled={!id || dirty || busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const result = await api(`/clients/${id}/personality`, 'POST');
            setDraft(result.text);
            setDemo(Boolean(result.demo));
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <Sparkles size={16} />
        )}{' '}
        Draft from business facts
      </button>
      <small>
        Uses saved direct facts and approved imports. Review the proposed
        personality before replacing your current instructions. AI usage may be
        charged.
      </small>
      <Result message={error} error />
      {draft && (
        <div className="draft-review">
          <strong>
            {demo
              ? 'Demo personality template'
              : 'Review the proposed personality'}
          </strong>
          <textarea
            aria-label="Proposed personality"
            rows={14}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="feature-actions">
            <button
              type="button"
              className="button primary"
              onClick={() => {
                onUse(draft);
                setDraft('');
              }}
            >
              Use this draft
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setDraft('')}
            >
              Discard
            </button>
          </div>
          <small>
            Using the draft updates the editor. Save the client to apply it.
          </small>
        </div>
      )}
    </div>
  );
}

export function KnowledgeLibrary({ id, api }: { id: string | null; api: Api }) {
  const [sources, setSources] = useState<Obj[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [url, setUrl] = useState(''),
    [crawl, setCrawl] = useState(false),
    [draft, setDraft] = useState<Obj | null>(null),
    [note, setNote] = useState(''),
    [view, setView] = useState<Obj | null>(null);
  async function reload() {
    if (id) setSources(await api(`/clients/${id}/sources`));
  }
  useEffect(() => {
    reload().catch((e) => setError(errorText(e)));
  }, [id]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (!id)
    return (
      <div className="notice">
        Save this client to unlock file imports and website crawling.
      </div>
    );
  return (
    <div className="knowledge-library">
      <div className="section-heading">
        <span className="section-icon">
          <FileText size={19} />
        </span>
        <div>
          <h2>Business library</h2>
          <p>Turn your business material into answers customers can trust.</p>
        </div>
      </div>
      <div className="import-grid">
        <label className={`import-drop ${busy ? 'disabled' : ''}`}>
          <FileText size={25} />
          <strong>Import a file</strong>
          <span>PDF · Word · Text · Images</span>
          <small>Up to 10 MB. English OCR for images and scanned PDFs.</small>
          <input
            aria-label="Import business facts file"
            type="file"
            accept=".pdf,.doc,.docx,.txt,.md,.csv,.png,.jpg,.jpeg,.webp"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file)
                void run(async () => {
                  const data = new FormData();
                  data.append('file', file);
                  const result = await api(
                    `/clients/${id}/import-file`,
                    'POST',
                    data,
                  );
                  setDraft({
                    title: file.name,
                    origin: file.name,
                    content: result.text,
                  });
                  setNote(result.note || '');
                });
            }}
          />
        </label>
        <div className="website-import">
          <Globe2 size={23} />
          <strong>Import a website</strong>
          <input
            aria-label="Business website URL"
            type="url"
            placeholder="https://your-business.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <label className="check-inline">
            <input
              type="checkbox"
              checked={crawl}
              onChange={(e) => setCrawl(e.target.checked)}
            />{' '}
            Crawl linked pages (up to 8)
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !url}
            onClick={() =>
              run(async () => {
                const result = await api(
                  `/clients/${id}/import-website`,
                  'POST',
                  { url, pages: crawl ? 8 : 1 },
                );
                setDraft({
                  title: new URL(url).hostname,
                  origin: url,
                  content: result.text,
                });
                setNote(
                  `${result.pages.length} page(s) extracted. ${result.note}`,
                );
              })
            }
          >
            Import website
          </button>
        </div>
      </div>
      <div className="feature-actions">
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => {
            setDraft({
              title: 'Business information',
              origin: 'Direct input',
              content: '',
            });
            setNote('');
          }}
        >
          + Add text as a source
        </button>
      </div>
      {busy && (
        <div className="notice" role="status">
          <LoaderCircle size={18} className="spin" /> Processing… larger
          documents can take up to 90 seconds.
        </div>
      )}
      <Result message={error} error />
      {draft && (
        <section className="draft-review">
          <h3>Review before the assistant uses it</h3>
          <p>
            {note ||
              'Check prices, hours, policies and contact details. Remove private information and instructions embedded in source material.'}
          </p>
          <label className="field">
            <span className="field-title">Source title</span>
            <input
              value={draft.title}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <textarea
            aria-label="Extracted business facts"
            rows={12}
            maxLength={100000}
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          />
          <small>
            {draft.content.length.toLocaleString()} characters · Only the
            reviewed text is saved; original files are not retained.
          </small>
          <div className="feature-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy || !draft.title.trim() || !draft.content.trim()}
              onClick={() =>
                run(async () => {
                  await api(`/clients/${id}/sources`, 'POST', {
                    ...draft,
                    approved: true,
                  });
                  setDraft(null);
                  await reload();
                })
              }
            >
              <Check size={16} /> Approve & add to library
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setDraft(null)}
            >
              Discard
            </button>
          </div>
        </section>
      )}
      <div className="library-heading">
        <h3>
          Saved sources <span>{sources.length}</span>
        </h3>
        <small>Only approved sources are used for answers.</small>
      </div>
      {sources.length === 0 ? (
        <div className="library-empty">
          Your library is ready for its first source.
        </div>
      ) : (
        sources.map((source) => (
          <div className="source-row" key={source.id}>
            <FileText size={20} />
            <div>
              <strong>{source.title}</strong>
              <small>
                {source.characters.toLocaleString()} characters ·{' '}
                {source.approved ? 'Approved' : 'Excluded from answers'}
              </small>
            </div>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() =>
                run(async () =>
                  setView(await api(`/clients/${id}/sources/${source.id}`)),
                )
              }
            >
              Read
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api(`/clients/${id}/sources/${source.id}`, 'PATCH', {
                    approved: !source.approved,
                  });
                  await reload();
                })
              }
            >
              {source.approved ? 'Exclude' : 'Approve'}
            </button>
            <button
              type="button"
              className="icon-button"
              title="Delete source"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(`Delete “${source.title}” from the library?`)
                )
                  void run(async () => {
                    await api(`/clients/${id}/sources/${source.id}`, 'DELETE');
                    await reload();
                  });
              }}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))
      )}
      {view && (
        <section className="draft-review">
          <strong>{view.title}</strong>
          <textarea
            aria-label="Saved source text"
            rows={10}
            readOnly
            value={view.content}
          />
          <button
            type="button"
            className="button secondary"
            onClick={() => setView(null)}
          >
            Close source
          </button>
        </section>
      )}
      <div className="knowledge-note">
        <Sparkles size={18} />
        <div>
          <strong>No extra embedding model needed</strong>
          <p>
            Relay searches approved text passages for each question and supplies
            the most relevant material to your chosen AI. For a large
            multilingual catalogue, semantic embeddings are a future upgrade.
            Review imports when prices or policies change.
          </p>
        </div>
      </div>
    </div>
  );
}

export function GoogleIntegration({
  id,
  api,
}: {
  id: string | null;
  api: Api;
}) {
  const [data, setData] = useState<Obj | null>(null),
    [settings, setSettings] = useState<Obj>({}),
    [gmail, setGmail] = useState(true),
    [calendar, setCalendar] = useState(true),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState(false);
  async function reload() {
    if (id) {
      const value = await api(`/clients/${id}/google`);
      setData(value);
      setSettings(value.settings);
    }
  }
  useEffect(() => {
    reload().catch((e) => {
      setMessage(errorText(e));
      setError(true);
    });
    const status = new URLSearchParams(location.hash.split('?')[1] || '').get(
      'google',
    );
    if (status) {
      setMessage(
        status === 'connected'
          ? 'Google connected. Review and enable the actions below.'
          : status === 'cancelled'
            ? 'Google connection was cancelled.'
            : 'Google connection failed. Check consent, redirect URI and OAuth settings, then reconnect.',
      );
      setError(status === 'failed');
    }
  }, [id]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await fn();
      setError(false);
    } catch (e) {
      setError(true);
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const set = (key: string, value: any) =>
    setSettings((s) => ({ ...s, [key]: value }));
  if (!id)
    return (
      <div className="notice">
        Save the client to configure Google integrations.
      </div>
    );
  if (!data)
    return (
      <Result message={message || 'Loading Google setup…'} error={error} />
    );
  return (
    <div className="google-integration">
      <div className="section-heading">
        <span className="section-icon">
          <Plug size={20} />
        </span>
        <div>
          <h2>Gmail & Google Calendar</h2>
          <p>
            Connect an account for this business. You decide what the assistant
            can do.
          </p>
        </div>
      </div>
      <div className="integration-status">
        <strong>
          {data.connected
            ? 'Google account connected'
            : 'Connect your business account'}
        </strong>
        <span className={'badge ' + (data.connected ? 'green' : 'gray')}>
          {data.connected ? 'Connected' : 'Not connected'}
        </span>
      </div>
      {!data.configured && (
        <div className="notice">
          <div>
            <strong>One-time setup in Railway</strong>
            <p>
              Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from a Google Cloud
              OAuth web client. Enable the Gmail and Calendar APIs. Register
              this redirect address:
            </p>
            <code className="wrap-code">{data.redirect_uri}</code>
            <p>
              In Google’s testing mode, add your Google account as a test user.
              Publish the consent configuration for ongoing use.
            </p>
          </div>
        </div>
      )}
      <div className="feature-actions">
        <label className="check-inline">
          <input
            type="checkbox"
            checked={gmail}
            onChange={(e) => setGmail(e.target.checked)}
          />{' '}
          Gmail send access
        </label>
        <label className="check-inline">
          <input
            type="checkbox"
            checked={calendar}
            onChange={(e) => setCalendar(e.target.checked)}
          />{' '}
          Calendar & availability
        </label>
      </div>
      <small>
        Gmail access sends approved messages; Relay does not read your inbox.
        Calendar access checks availability and creates customer-confirmed
        calls.
      </small>
      <div className="feature-actions">
        <button
          type="button"
          className="button primary"
          disabled={
            busy || !data.configured || data.demo || (!gmail && !calendar)
          }
          onClick={() =>
            run(async () => {
              const result = await api(
                `/clients/${id}/google/connect`,
                'POST',
                { gmail, calendar },
              );
              window.location.assign(result.url);
            })
          }
        >
          {data.connected ? 'Reconnect Google' : 'Connect Google'}
        </button>
        {data.connected && (
          <>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const result = await api(
                    `/clients/${id}/google/test`,
                    'POST',
                  );
                  setMessage(result.message);
                })
              }
            >
              Test Google connection
            </button>
            <button
              type="button"
              className="text-button danger"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    'Disconnect Google and stop email and booking automation for this client?',
                  )
                )
                  void run(async () => {
                    await api(`/clients/${id}/google`, 'DELETE');
                    await reload();
                    setMessage('Google disconnected.');
                  });
              }}
            >
              Disconnect
            </button>
          </>
        )}
      </div>
      <Result message={message} error={error} />
      {data.connected && (
        <>
          <div className="form-divider" />
          <label className="toggle-row">
            <span>
              <strong>Automated business information email</strong>
              <small>
                Sent only after the customer requests and confirms it.
              </small>
            </span>
            <input
              className="switch"
              type="checkbox"
              checked={settings.email_enabled}
              onChange={(e) => set('email_enabled', e.target.checked)}
            />
          </label>
          <label className="field">
            <span className="field-title">Email subject</span>
            <input
              value={settings.email_subject}
              maxLength={150}
              onChange={(e) => set('email_subject', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-title">Approved email content</span>
            <textarea
              rows={6}
              maxLength={5000}
              value={settings.email_body}
              onChange={(e) => set('email_body', e.target.value)}
            />
            <small>
              This exact text is sent. Include your useful business details and
              next step.
            </small>
          </label>
          <label className="toggle-row">
            <span>
              <strong>Customer call scheduling</strong>
              <small>
                Checks calendar availability before creating an invitation.
              </small>
            </span>
            <input
              className="switch"
              type="checkbox"
              checked={settings.calendar_enabled}
              onChange={(e) => set('calendar_enabled', e.target.checked)}
            />
          </label>
          <div className="field-grid">
            {[
              ['calendar_id', 'Calendar ID'],
              ['timezone', 'Time zone'],
            ].map(([key, label]) => (
              <label className="field" key={key}>
                <span className="field-title">{label}</span>
                <input
                  value={settings[key]}
                  onChange={(e) => set(key, e.target.value)}
                />
              </label>
            ))}
            {[
              ['duration', 'Call duration (minutes)', 15, 120],
              ['start_hour', 'Opening hour', 0, 23],
              ['end_hour', 'Closing hour', 1, 24],
            ].map(([key, label, min, max]) => (
              <label className="field" key={String(key)}>
                <span className="field-title">{label}</span>
                <input
                  type="number"
                  min={Number(min)}
                  max={Number(max)}
                  value={settings[key]}
                  onChange={(e) => set(String(key), Number(e.target.value))}
                />
              </label>
            ))}
          </div>
          <div className="weekday-picker">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => (
              <label key={day}>
                <input
                  type="checkbox"
                  checked={settings.weekdays.includes(i)}
                  onChange={(e) =>
                    set(
                      'weekdays',
                      e.target.checked
                        ? [...settings.weekdays, i].sort()
                        : settings.weekdays.filter((d: number) => d !== i),
                    )
                  }
                />
                {day}
              </label>
            ))}
          </div>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api(`/clients/${id}/google`, 'PUT', settings);
                setMessage('Google automation settings saved.');
              })
            }
          >
            Save automation settings
          </button>
        </>
      )}
      <section className="knowledge-note">
        <ShieldIcon />
        <div>
          <strong>Customer confirmation, every time</strong>
          <p>
            The assistant guides customers through{' '}
            <code>/email their-address</code> or{' '}
            <code>/book date-time their-address</code>, then asks them to
            confirm the exact recipient and booking. No imported file or AI
            response can execute an action. Requests expire after 15 minutes,
            with a limit of five per customer per day.
          </p>
        </div>
      </section>
    </div>
  );
}
function ShieldIcon() {
  return <Check size={20} />;
}

function LeadDialog({
  children,
  close,
}: {
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    const focus = document.activeElement as HTMLElement;
    element?.showModal();
    return () => {
      element?.close();
      focus?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="panel lead-edit"
      aria-label="Edit lead"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {children}
    </dialog>
  );
}
export function LeadTracker({ api }: { api: Api }) {
  const [clients, setClients] = useState<Obj[]>([]),
    [client, setClient] = useState(''),
    [stage, setStage] = useState(''),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(0),
    [data, setData] = useState<Obj>({ leads: [], total: 0 }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [version, setVersion] = useState(0),
    [editing, setEditing] = useState<Obj | null>(null),
    [busy, setBusy] = useState(false);
  const query = new URLSearchParams({
    client,
    stage,
    search,
    page: String(page),
  }).toString();
  useEffect(() => {
    api('/clients')
      .then(setClients)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(
      () =>
        api('/leads?' + query)
          .then((value) => {
            if (active) {
              setData(value);
              setError('');
            }
          })
          .catch((e) => {
            if (active) setError(errorText(e));
          })
          .finally(() => {
            if (active) setLoading(false);
          }),
      200,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, version]);
  return (
    <div className="page leads-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">FROM CONVERSATION TO CUSTOMER</span>
          <h1>Lead tracker</h1>
          <p>
            Follow every enquiry, keep the context, and choose the next step.
          </p>
        </div>
        <a
          className="button primary"
          href={'/api/leads/export.csv?' + query}
          download
        >
          <ArrowDownToLine size={17} /> Download chats & leads
        </a>
      </div>
      <div className="lead-summary">
        <span className="section-icon">
          <Users size={24} />
        </span>
        <div>
          <strong>{data.total.toLocaleString()}</strong>
          <span> leads matching your filters</span>
        </div>
        <p>
          Mobile numbers and chats appear automatically when customers message a
          connected WhatsApp number.
        </p>
      </div>
      <div className="panel">
        <div className="lead-filters">
          <input
            aria-label="Search leads"
            placeholder="Search name, client or last phone digits…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
          <select
            aria-label="Filter leads by client"
            value={client}
            onChange={(e) => {
              setClient(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.client_name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter lead stage"
            value={stage}
            onChange={(e) => {
              setStage(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All stages</option>
            {['new', 'qualified', 'contacted', 'won', 'lost'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            title="Refresh leads"
            onClick={() => setVersion((v) => v + 1)}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        <Result message={error} error />
        {loading ? (
          <div className="library-empty" role="status">
            Loading leads…
          </div>
        ) : data.leads.length ? (
          <div className="table-scroll">
            <table className="lead-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Business</th>
                  <th>Stage</th>
                  <th>Latest conversation</th>
                  <th>Last active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.leads.map((lead: Obj) => (
                  <tr key={lead.id}>
                    <td>
                      <strong>{lead.lead_name || 'New contact'}</strong>
                      <small>+{lead.phone.replace(/^\+/, '')}</small>
                    </td>
                    <td>{lead.client_name}</td>
                    <td>
                      <span className={'lead-stage stage-' + lead.lead_stage}>
                        {lead.lead_stage}
                      </span>
                    </td>
                    <td>
                      <a href={'#/conversations/' + lead.id}>
                        {lead.last_message?.slice(0, 100) ||
                          'Open conversation'}
                      </a>
                      <small>
                        {lead.messages} messages ·{' '}
                        {lead.status === 'human' ? 'With team' : 'Assistant'}
                      </small>
                    </td>
                    <td>{new Date(lead.last_user_at).toLocaleDateString()}</td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => setEditing({ ...lead })}
                      >
                        Edit lead
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="library-empty">
            <Users size={28} />
            <h3>No leads here yet</h3>
            <p>
              Try another filter or send a message to your connected WhatsApp
              business number.
            </p>
          </div>
        )}
        <div className="lead-pagination">
          <button
            className="button secondary"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span>
            Page {page + 1} of {Math.max(1, Math.ceil(data.total / 30))}
          </span>
          <button
            className="button secondary"
            disabled={(page + 1) * 30 >= data.total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </div>
      <p className="lead-export-note">
        CSV includes one row per chat message and all matching leads across
        pages. Exports contain customer information; share them only with your
        team. Chats follow the workspace’s 90-day retention policy.
      </p>
      {editing && (
        <LeadDialog
          close={() => {
            if (!busy) setEditing(null);
          }}
        >
          <h2>Update lead</h2>
          <p>+{editing.phone.replace(/^\+/, '')}</p>
          <label className="field">
            <span className="field-title">Customer name</span>
            <input
              autoFocus
              maxLength={120}
              value={editing.lead_name}
              onChange={(e) =>
                setEditing({ ...editing, lead_name: e.target.value })
              }
            />
          </label>
          <label className="field">
            <span className="field-title">Stage</span>
            <select
              value={editing.lead_stage}
              onChange={(e) =>
                setEditing({ ...editing, lead_stage: e.target.value })
              }
            >
              {['new', 'qualified', 'contacted', 'won', 'lost'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-title">Team notes</span>
            <textarea
              rows={5}
              maxLength={3000}
              value={editing.lead_notes}
              onChange={(e) =>
                setEditing({ ...editing, lead_notes: e.target.value })
              }
            />
          </label>
          <div className="feature-actions">
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api('/leads/' + editing.id, 'PATCH', editing);
                  setEditing(null);
                  setVersion((v) => v + 1);
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save lead
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
          </div>
        </LeadDialog>
      )}
    </div>
  );
}
