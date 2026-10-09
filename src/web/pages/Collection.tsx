import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { TitleCard } from '../../shared/types.ts';
import { get } from '../api.ts';
import { img } from '../format.ts';
import { BulkAddDialog, useQuickAdd } from '../components/AddDialog.tsx';
import { PosterGrid } from '../components/Poster.tsx';
import { Button, ErrorBox, ProgressBar, Spinner } from '../components/ui.tsx';

interface CollectionDetail {
  id: number;
  name: string;
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
  have: number;
  total: number;
  parts: TitleCard[];
}

export default function CollectionPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['collection', id], queryFn: () => get<CollectionDetail>(`/collection/${id}`) });
  const [bulk, setBulk] = useState(false);
  const { onAdd, dialog } = useQuickAdd();
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const c = q.data!;
  const missing = c.parts.filter((p) => p.state.kind === 'none' || p.state.kind === 'requested');
  return (
    <div>
      <div className="relative -mx-4 -mt-5 mb-6 overflow-hidden">
        {c.backdropPath && <img src={img(c.backdropPath, 'w1280')} alt="" className="absolute inset-0 size-full object-cover opacity-25" />}
        <div className="absolute inset-0 bg-gradient-to-t from-bg to-bg/40" />
        <div className="relative px-4 py-8 max-w-3xl">
          <h1 className="text-3xl font-bold tracking-tight">{c.name}</h1>
          {c.overview && <p className="text-sm mt-2 text-muted leading-relaxed">{c.overview}</p>}
          <div className="mt-4 max-w-sm">
            <div className="text-sm mb-1.5">
              You have <span className="font-semibold">{c.have}</span> of {c.total}
            </div>
            <ProgressBar value={(c.have / Math.max(1, c.total)) * 100} tone={c.have === c.total ? 'ok' : 'info'} />
          </div>
          {missing.length > 0 && (
            <Button variant="primary" className="mt-4" onClick={() => setBulk(true)}>
              <Plus className="size-4" /> Add the {missing.length} missing
            </Button>
          )}
        </div>
      </div>
      <PosterGrid cards={c.parts} onAdd={onAdd} />
      <BulkAddDialog open={bulk} onClose={() => setBulk(false)} cards={c.parts} title={`Add missing from ${c.name}`} />
      {dialog}
    </div>
  );
}
