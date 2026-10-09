import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import type { MediaType, Page, TitleCard } from '../../shared/types.ts';
import { get } from '../api.ts';
import { Rail } from '../components/Rail.tsx';
import { Segmented, ErrorBox } from '../components/ui.tsx';
import { useQuickAdd } from '../components/AddDialog.tsx';
import { SelectToggle } from '../components/Selection.tsx';
import { Toggle } from '../components/ui.tsx';
import { useHideOwned } from '../prefs.ts';

function DiscoverRail({ type, rail, title, onAdd, hide }: { type: MediaType; rail: string; title: string; onAdd: (c: TitleCard) => void; hide: boolean }) {
  const q = useQuery({ queryKey: ['rail', type, rail, 1, hide], queryFn: () => get<Page<TitleCard>>(`/discover/rail/${rail}?type=${type}&page=1${hide ? '&hide=1' : ''}`) });
  if (q.error) return <ErrorBox error={q.error} />;
  return <Rail title={title} cards={q.data?.results} loading={q.isLoading} seeAll={`/rail/${type}/${rail}?title=${encodeURIComponent(title)}`} onAdd={onAdd} />;
}

export default function DiscoverPage() {
  const [params, setParams] = useSearchParams();
  const type = (params.get('type') === 'tv' ? 'tv' : 'movie') as MediaType;
  const rails = useQuery({ queryKey: ['rails', type], queryFn: () => get<{ id: string; title: string }[]>(`/discover/rails?type=${type}`), staleTime: Infinity });
  const { onAdd, dialog } = useQuickAdd();
  const [hide, setHide] = useHideOwned();
  return (
    <div>
      <div className="flex items-center justify-between mb-5 gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Discover</h1>
        <div className="flex items-center gap-3 flex-wrap justify-end">
        <Toggle checked={hide} onChange={setHide} label="Hide titles I have" />
        <SelectToggle />
        <Segmented
          value={type}
          onChange={(v) => setParams(v === 'movie' ? {} : { type: v })}
          options={[
            { value: 'movie', label: 'Movies' },
            { value: 'tv', label: 'TV' },
          ]}
        />
        </div>
      </div>
      {rails.error && <ErrorBox error={rails.error} />}
      {rails.data?.map((r) => <DiscoverRail key={`${type}-${r.id}-${hide}`} type={type} rail={r.id} title={r.title} onAdd={onAdd} hide={hide} />)}
      {dialog}
    </div>
  );
}
