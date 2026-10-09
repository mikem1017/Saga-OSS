import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { GuestCard, MediaType } from '../types.ts';
import { get } from '../api.ts';
import { Grid, Loading } from '../components.tsx';
import { inputCls } from '../../components/ui.tsx';

export default function SearchPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const q = sp.get('q') ?? '';
  const [text, setText] = useState(q);
  useEffect(() => {
    setText(q);
  }, [q]);
  const { data, isFetching } = useQuery({
    queryKey: ['search', q],
    queryFn: () => get<{ match: { mediaType: MediaType; tmdbId: number } | null; results: GuestCard[] }>(`/search?q=${encodeURIComponent(q)}`),
    enabled: !!q,
  });
  useEffect(() => {
    if (data?.match) navigate(`/${data.match.mediaType}/${data.match.tmdbId}`, { replace: true });
  }, [data, navigate]);
  return (
    <div>
      <form
        role="search"
        className="relative mb-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) setSp({ q: text.trim() });
        }}
      >
        <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} className={`${inputCls} pl-9 py-2.5`} placeholder="Search films and shows, or paste an IMDb / Letterboxd / TMDB link" aria-label="Search" />
      </form>
      {isFetching ? <Loading /> : data && !data.match && (data.results.length ? <Grid cards={data.results} /> : <p className="text-muted text-sm">Nothing found for “{q}”.</p>)}
    </div>
  );
}
