import { useEffect, useRef, useState } from 'react';
type Obj = Record<string, any>;
export function ProviderSetup({
  id,
  form,
  set,
  api,
}: {
  id: string | null;
  form: Obj;
  set: (key: string, value: any) => void;
  api: (path: string, method?: string, body?: any) => Promise<any>;
}) {
  const [options, setOptions] = useState<Obj>({}),
    [models, setModels] = useState<string[]>([]),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [result, setResult] = useState('');
  const generation = useRef(0);
  const provider = options[form.llm_provider] || {};
  const base = form.llm_base_url || provider.baseUrl || '';
  const fingerprint = JSON.stringify([
    id,
    form.llm_provider,
    base,
    form.llm_api_key,
  ]);
  const payload = () => ({
    client_id: id,
    provider: form.llm_provider,
    base_url: base,
    api_key: form.llm_api_key || '',
    model: form.llm_model || '',
  });
  useEffect(() => {
    api('/provider-options')
      .then(setOptions)
      .catch((e) => setError(e.message));
  }, [api]);
  async function discover(version = ++generation.current) {
    setBusy('models');
    setError('');
    setModels([]);
    try {
      const data = await api('/ai/models', 'POST', payload());
      if (version === generation.current) setModels(data.models);
    } catch (e: any) {
      if (version === generation.current) setError(e.message);
    } finally {
      if (version === generation.current) setBusy('');
    }
  }
  useEffect(() => {
    generation.current++;
    setResult('');
    setBusy('');
  }, [form.llm_model]);
  useEffect(() => {
    const version = ++generation.current;
    setModels([]);
    setError('');
    setResult('');
    setBusy('');
    if (!base || !(form.llm_api_key?.trim() || form.has_llm_api_key)) return;
    const timer = setTimeout(() => void discover(version), 1200);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [fingerprint]);
  return (
    <section className="provider-setup">
      <label className="field">
        <span className="field-title">1. Provider</span>
        <select
          value={form.llm_provider}
          onChange={(e) => {
            const value = e.target.value;
            set('llm_provider', value);
            set('llm_base_url', options[value]?.baseUrl || '');
            set('llm_api_key', '');
            set('has_llm_api_key', false);
            set('llm_model', '');
          }}
        >
          {Object.entries(options).map(([key, p]) => (
            <option key={key} value={key}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-title">2. Base URL</span>
        <input
          type="url"
          value={base}
          placeholder="https://your-provider.example/v1"
          onChange={(e) => set('llm_base_url', e.target.value)}
        />
        <small>
          Filled from your provider. You can edit it for a compatible endpoint.
        </small>
      </label>
      <label className="field">
        <span className="field-title">3. API key</span>
        <input
          type="password"
          autoComplete="new-password"
          value={form.llm_api_key || ''}
          placeholder={
            form.has_llm_api_key
              ? 'Saved securely — leave blank to keep'
              : 'Paste API key'
          }
          onChange={(e) => set('llm_api_key', e.target.value)}
        />
        <small>
          Models load automatically after you enter a key. Re-enter it when
          changing provider or address.
        </small>
      </label>
      {provider.keyUrl && (
        <a
          href={provider.keyUrl}
          target="_blank"
          rel="noreferrer"
          className="text-button"
        >
          Get API token from {provider.label} ↗
        </a>
      )}
      <label className="field">
        <span className="field-title">4. Model</span>
        {models.length > 0 && (
          <select
            aria-label="Available AI models"
            value={models.includes(form.llm_model) ? form.llm_model : ''}
            onChange={(e) => set('llm_model', e.target.value)}
          >
            <option value="">Select a model or enter its ID below</option>
            {models.map((model) => (
              <option key={model}>{model}</option>
            ))}
          </select>
        )}
        <input
          aria-label="Model ID"
          value={form.llm_model || ''}
          onChange={(e) => set('llm_model', e.target.value)}
          placeholder="Exact model ID"
          required
        />
        <small>
          {busy === 'models'
            ? 'Fetching models…'
            : 'You can also enter a model ID manually if your provider does not list models.'}
        </small>
      </label>
      <button
        type="button"
        className="button secondary"
        disabled={!!busy || !base}
        onClick={() => void discover()}
      >
        Refresh model list
      </button>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="feature-actions setup-final">
        <button
          type="button"
          className="button secondary"
          disabled={!!busy || !form.llm_model}
          onClick={async () => {
            const version = ++generation.current,
              model = form.llm_model;
            setBusy('test');
            setError('');
            setResult('');
            try {
              const response = await api('/ai/test', 'POST', payload());
              if (version === generation.current && model === form.llm_model)
                setResult(response.message);
            } catch (e: any) {
              if (version === generation.current) setError(e.message);
            } finally {
              if (version === generation.current) setBusy('');
            }
          }}
        >
          {busy === 'test' ? 'Testing…' : '5. Test API'}
        </button>
        <button type="submit" className="button primary" disabled={!!busy}>
          6. Save changes
        </button>
      </div>
      <small>
        Testing uses the values above before saving. Provider usage charges may
        apply.
      </small>
      {result && (
        <div className="notice subtle" role="status">
          {result}
        </div>
      )}
    </section>
  );
}
