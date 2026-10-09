import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { MediaType, Page, TitleCard } from '../../shared/types.ts';
import { get } from '../api.ts';
import { BulkAddDialog, useQuickAdd } from '../components/AddDialog.tsx';
import { PosterGrid } from '../components/Poster.tsx';
import { Button, ErrorBox, PageHeader, Spinner } from '../components/ui.tsx';

interface SearchResponse {
  match?: { mediaType: MediaType; tmdbId: number };
  source: string;
  list?: { kind: string; ref: string };
  results: Page<TitleCard>;
}

export default function SearchPage() {
  const [params] = useSearchParams();
  const term = params.get('q') ?? '';
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['search', term], queryFn: () => get<SearchResponse>(`/search?q=${encodeURIComponent(term)}`), enabled: !!term });
  const { onAdd, dialog } = useQuickAdd();
  const [bulk, setBulk] = useState(false);
  useEffect(() => {
    if (q.data?.match) navigate(`/${q.data.match.mediaType}/${q.data.match.tmdbId}`, { replace: true });
    else if (q.data?.source === 'list') navigate(`/lists/view?url=${encodeURIComponent(term)}`, { replace: true });
  }, [q.data, navigate, term]);

  if (!term) return <PageHeader title="Search" sub="Type a title, or paste an IMDb, TMDB, TVDB, Trakt or Letterboxd link (or a list URL)." />;
  const cards = q.data?.results.results ?? [];
  const missing = cards.filter((c) => c.state.kind === 'none');
  return (
    <div>
      <PageHeader
        title={`“${term}”`}
        sub={q.data ? `${q.data.results.totalResults.toLocaleString()} results · ${q.data.source}` : undefined}
        actions={
          missing.length > 1 ? (
            <Button onClick={() => setBulk(true)}>
              <Plus className="size-4" /> Add several…
            </Button>
          ) : undefined
        }
      />
      {q.isLoading && <Spinner label="Searching" />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && !q.data.match && q.data.source !== 'list' && (cards.length ? <PosterGrid cards={cards} onAdd={onAdd} /> : <p className="text-muted text-sm">Nothing found. {q.data.source.includes('not found') ? 'TMDB has no title for that id.' : ''}</p>)}
      <BulkAddDialog open={bulk} onClose={() => setBulk(false)} cards={missing.map((c) => c)} title="Add from search" />
      {dialog}
    </div>
  );
}
