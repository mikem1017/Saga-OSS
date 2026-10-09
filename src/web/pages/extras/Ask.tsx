import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import type { TitleCard } from '../../../shared/types.ts';
import { get, post, put } from '../../api.ts';
import { relTime } from '../../format.ts';
import { Button, Card, ErrorBox, inputCls } from '../../components/ui.tsx';
import { PosterGrid } from '../../components/Poster.tsx';
import { BulkAddDialog, useQuickAdd } from '../../components/AddDialog.tsx';

interface NlStatus {
  enabled: boolean;
  model: string | null;
  capUsd: number;
  costUsd: number;
  queries: number;
  recent: { ts: number; prompt: string; costUsd: number; ok: number; error: string | null }[];
}
interface NlResult {
  filters: { summary: string; library: string; mediaType: string };
  dropped: string[];
  results: TitleCard[];
  monthToDate: { costUsd: number; queries: number };
}

const EXAMPLES = ['90s heist films I don’t have', 'acclaimed Korean thrillers from the last 10 years', 'Michael Mann films missing from the library', 'cozy British mystery series', 'what do I already have in 4K from Christopher Nolan'];

export default function AskPage() {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [bulk, setBulk] = useState(false);
  const { onAdd, dialog } = useQuickAdd();
  const status = useQuery({ queryKey: ['extras-nl'], queryFn: () => get<NlStatus>('/extras/nl') });
  const run = useMutation({
    mutationFn: (p: string) => post<NlResult>('/extras/nl', { prompt: p }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['extras-nl'] }),
  });
  const [cap, setCap] = useState<string>('');
  const saveCap = useMutation({ mutationFn: (v: number) => put<NlStatus>('/extras/nl', { capUsd: v }), onSuccess: (s) => qc.setQueryData(['extras-nl'], s) });
  const s = status.data;
  const submit = (p: string) => {
    if (p.trim().length >= 3) run.mutate(p.trim());
  };
  return (
    <div className="space-y-4">
      <Card>
        <form
          className="flex flex-col sm:flex-row gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(prompt);
          }}
        >
          <input
            className={`${inputCls} flex-1`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe what you're looking for, e.g. “90s heist films in 4K I don’t have”"
            aria-label="Describe what you're looking for"
            maxLength={400}
            disabled={s && !s.enabled}
          />
          <Button variant="primary" type="submit" busy={run.isPending} disabled={!s?.enabled || prompt.trim().length < 3}>
            <Sparkles className="size-4" /> Ask
          </Button>
        </form>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              className="text-xs rounded-full border border-line px-2.5 py-1 text-muted hover:text-fg disabled:opacity-50"
              disabled={!s?.enabled || run.isPending}
              onClick={() => {
                setPrompt(e);
                submit(e);
              }}
            >
              {e}
            </button>
          ))}
        </div>
        {s && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted mt-3">
            {s.enabled ? (
              <>
                <span>
                  {s.model} · ${s.costUsd.toFixed(3)} of ${s.capUsd.toFixed(2)} this month · {s.queries} quer{s.queries === 1 ? 'y' : 'ies'}
                </span>
                <form
                  className="flex items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = Number(cap);
                    if (Number.isFinite(v) && v >= 0) saveCap.mutate(v);
                  }}
                >
                  <label htmlFor="nl-cap">Monthly cap $</label>
                  <input id="nl-cap" className={`${inputCls} w-20 py-1`} inputMode="decimal" placeholder={String(s.capUsd)} value={cap} onChange={(e) => setCap(e.target.value)} />
                  <Button size="sm" type="submit" busy={saveCap.isPending} disabled={!cap}>
                    Save
                  </Button>
                </form>
              </>
            ) : (
              <span className="text-warn">Off: add ANTHROPIC_API_KEY (and ANTHROPIC_WORKSPACE_ID if the key is workspace-scoped) to Saga's .env.</span>
            )}
          </div>
        )}
      </Card>
      {run.error && <ErrorBox error={run.error} />}
      {run.data && (
        <Card
          title={`${run.data.results.length} result${run.data.results.length === 1 ? '' : 's'}`}
          actions={
            run.data.results.some((r) => r.state.kind === 'none') ? (
              <Button size="sm" onClick={() => setBulk(true)}>
                Select and add…
              </Button>
            ) : undefined
          }
        >
          <p className="text-sm mb-1">{run.data.filters.summary}</p>
          {run.data.dropped.length > 0 && <p className="text-xs text-muted mb-3">Couldn't use: {run.data.dropped.join(', ')}.</p>}
          <PosterGrid cards={run.data.results} onAdd={onAdd} />
          {!run.data.results.length && <p className="text-sm text-muted py-4">No matches. Try a broader description.</p>}
        </Card>
      )}
      {s && s.recent.length > 0 && (
        <Card title="Recent questions">
          <ul className="text-sm divide-y divide-line">
            {s.recent.map((r) => (
              <li key={r.ts} className="py-1.5 flex gap-2 items-baseline">
                <button className="text-left hover:text-accent flex-1 truncate" onClick={() => setPrompt(r.prompt)}>
                  {r.prompt}
                </button>
                <span className="text-xs text-muted whitespace-nowrap">
                  {r.ok ? `$${r.costUsd.toFixed(4)}` : <span className="text-bad">{r.error ?? 'failed'}</span>} · {relTime(r.ts)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {dialog}
      {run.data && <BulkAddDialog open={bulk} onClose={() => setBulk(false)} cards={run.data.results} title="Add from your search" />}
    </div>
  );
}
