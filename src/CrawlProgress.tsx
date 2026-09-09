import { useEffect, useState } from 'react';
export function CrawlProgress({
  id,
  api,
  refresh,
  changed,
}: {
  id: string;
  api: any;
  refresh: number;
  changed: () => void;
}) {
  const [runs, setRuns] = useState<any[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api(`/clients/${id}/crawls`);
        if (disposed) return;
        setRuns(data);
        changed();
        setError('');
      } catch (e: any) {
        if (!disposed) setError(e.message);
      }
      if (!disposed) timer = setTimeout(poll, 4000);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [id, refresh]);
  return (
    <div className="crawl-progress">
      {error && <div className="error">{error}</div>}
      {runs.map((run) => (
        <div className="feature-block" key={run.id}>
          <strong>
            {new URL(run.url).hostname} · {run.status}
          </strong>
          <p>
            {run.completed} pages imported · {run.remaining} waiting ·{' '}
            {run.failed} skipped or failed
          </p>
          <small>
            Each imported page appears below for review and approval.
          </small>
          {run.note && <p className="field-hint">{run.note}</p>}
          {run.status !== 'completed' && (
            <button
              type="button"
              className="button secondary"
              onClick={async () => {
                try {
                  await api(
                    `/clients/${id}/crawls/${run.id}/${run.status === 'running' ? 'stop' : 'resume'}`,
                    'POST',
                  );
                  setRuns(await api(`/clients/${id}/crawls`));
                } catch (e: any) {
                  setError(e.message);
                }
              }}
            >
              {run.status === 'running' ? 'Stop crawl' : 'Resume crawl'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
