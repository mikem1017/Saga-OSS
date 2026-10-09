import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { TitleCard } from '../../shared/types.ts';
import { get } from '../api.ts';
import { img } from '../format.ts';
import { BulkAddDialog, useQuickAdd } from '../components/AddDialog.tsx';
import { PosterGrid } from '../components/Poster.tsx';
import { Button, ErrorBox, Segmented, Spinner } from '../components/ui.tsx';

interface PersonDetail {
  id: number;
  name: string;
  biography?: string;
  profilePath?: string;
  knownFor?: string;
  birthday?: string;
  deathday?: string;
  imdbId?: string;
  credits: TitleCard[];
}

const CREW_JOBS: Record<string, string[]> = {
  directing: ['Director'],
  writing: ['Writer', 'Screenplay', 'Creator', 'Story', 'Novel'],
  producing: ['Producer', 'Executive Producer'],
  music: ['Original Music Composer', 'Music'],
};

export default function PersonPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['person', id], queryFn: () => get<PersonDetail>(`/person/${id}`) });
  const [media, setMedia] = useState<'all' | 'movie' | 'tv'>('movie');
  const [role, setRole] = useState<string>('all');
  const [bulk, setBulk] = useState(false);
  const [bioOpen, setBioOpen] = useState(false);
  const { onAdd, dialog } = useQuickAdd();

  const filtered = useMemo(() => {
    const credits = q.data?.credits ?? [];
    return credits.filter((c) => {
      if (media !== 'all' && c.mediaType !== media) return false;
      if (role === 'all') return true;
      const r = c.role ?? '';
      if (role === 'acting') return !Object.values(CREW_JOBS).flat().includes(r);
      return CREW_JOBS[role]?.includes(r) ?? false;
    });
  }, [q.data, media, role]);

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const p = q.data!;
  const missing = filtered.filter((c) => c.state.kind === 'none' || c.state.kind === 'requested');
  const roleWord = role === 'directing' ? ' as director' : role === 'writing' ? ' as writer' : role === 'acting' ? ' as actor' : '';
  const roles = ['all', 'acting', ...Object.keys(CREW_JOBS)].filter((r) => r === 'all' || (q.data!.credits.some((c) => (r === 'acting' ? !Object.values(CREW_JOBS).flat().includes(c.role ?? '') : CREW_JOBS[r]?.includes(c.role ?? '')))));
  const have = filtered.length - missing.length;

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-6 mb-6">
        <div className="w-36 shrink-0 mx-auto sm:mx-0">
          <div className="aspect-[2/3] rounded-xl overflow-hidden border border-line bg-surface-2">{p.profilePath && <img src={img(p.profilePath, 'w342')} alt="" className="size-full object-cover" />}</div>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-bold tracking-tight">{p.name}</h1>
          <p className="text-sm text-muted mt-1">
            {p.knownFor}
            {p.birthday && ` · born ${p.birthday}`}
            {p.deathday && ` · died ${p.deathday}`}
          </p>
          {p.biography && (
            <p className={`text-sm leading-relaxed mt-3 max-w-3xl ${bioOpen ? '' : 'line-clamp-4'}`}>
              {p.biography}
            </p>
          )}
          {p.biography && p.biography.length > 400 && (
            <button className="text-xs text-accent mt-1" onClick={() => setBioOpen(!bioOpen)}>
              {bioOpen ? 'Less' : 'More'}
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Segmented
          value={media}
          onChange={setMedia}
          options={[
            { value: 'movie', label: 'Movies' },
            { value: 'tv', label: 'TV' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Segmented value={role} onChange={setRole} options={roles.map((r) => ({ value: r, label: r[0]!.toUpperCase() + r.slice(1) }))} />
        <span className="text-sm text-muted">
          {have} of {filtered.length} in library
        </span>
        {missing.length > 0 && (
          <Button variant="primary" className="ml-auto" onClick={() => setBulk(true)}>
            <Plus className="size-4" /> Add every missing {media === 'tv' ? 'show' : media === 'movie' ? 'film' : 'title'}
            {roleWord} ({missing.length})
          </Button>
        )}
      </div>
      <PosterGrid cards={filtered} onAdd={onAdd} />
      <BulkAddDialog open={bulk} onClose={() => setBulk(false)} cards={filtered} title={`Add ${p.name}${roleWord}`} />
      {dialog}
    </div>
  );
}
