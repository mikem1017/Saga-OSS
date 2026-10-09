import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { TitleCard } from '../../shared/types.ts';
import { get, qs } from '../api.ts';
import { BulkAddDialog, useQuickAdd } from '../components/AddDialog.tsx';
import { PosterGrid } from '../components/Poster.tsx';
import { Button, ErrorBox, PageHeader, ProgressBar, Segmented, Spinner } from '../components/ui.tsx';

interface ResolvedList {
  kind: string;
  ref: string;
  name: string;
  total: number;
  have: number;
  unresolved: number;
  items: TitleCard[];
}

export default function ListViewPage() {
  const [params] = useSearchParams();
  const url = params.get('url') ?? '';
  const kind = params.get('kind') ?? undefined;
  const q = useQuery({ queryKey: ['list', url, kind], queryFn: () => get<ResolvedList>(`/lists/view${qs({ url, kind })}`), enabled: !!url, staleTime: 5 * 60_000 });
  const [filter, setFilter] = useState<'all' | 'missing' | 'have'>('all');
  const [bulk, setBulk] = useState(false);
  const { onAdd, dialog } = useQuickAdd();
  const items = useMemo(() => {
    const all = q.data?.items ?? [];
    if (filter === 'missing') return all.filter((c) => c.state.kind === 'none' || c.state.kind === 'requested');
    if (filter === 'have') return all.filter((c) => c.state.kind !== 'none' && c.state.kind !== 'requested');
    return all;
  }, [q.data, filter]);
  if (q.isLoading)
    return (
      <div>
        <Spinner label="Reading the list and matching titles to TMDB" />
        <p className="text-center text-xs text-muted">A large list can take ~30 s the first time; after that it's cached for an hour.</p>
      </div>
    );
  if (q.error) return <ErrorBox error={q.error} />;
  const l = q.data!;
  const missing = l.total - l.have;
  return (
    <div>
      <PageHeader
        title={l.name}
        sub={
          <>
            {l.have} of {l.total} in library{l.unresolved ? ` · ${l.unresolved} couldn't be matched to TMDB` : ''}
          </>
        }
        actions={
          missing > 0 ? (
            <Button variant="primary" onClick={() => setBulk(true)}>
              <Plus className="size-4" /> Add all missing ({missing})
            </Button>
          ) : undefined
        }
      />
      <div className="max-w-md mb-4">
        <ProgressBar value={(l.have / Math.max(1, l.total)) * 100} tone={missing === 0 ? 'ok' : 'info'} />
      </div>
      <div className="mb-4">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All ${l.total}` },
            { value: 'missing', label: `Missing ${missing}` },
            { value: 'have', label: `Have ${l.have}` },
          ]}
        />
      </div>
      <PosterGrid cards={items} onAdd={onAdd} />
      <BulkAddDialog open={bulk} onClose={() => setBulk(false)} cards={l.items} title={`Add missing from ${l.name}`} />
      {dialog}
    </div>
  );
}
