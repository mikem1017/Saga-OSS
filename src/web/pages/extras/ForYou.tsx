import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MediaType, TitleCard } from '../../../shared/types.ts';
import { get } from '../../api.ts';
import { Button, ErrorBox, Spinner } from '../../components/ui.tsx';
import { Rail } from '../../components/Rail.tsx';
import { BulkAddDialog, useQuickAdd } from '../../components/AddDialog.tsx';

interface ForYou {
  users: { userId: number; user: string; seeds: { title: string; mediaType: MediaType; plays: number }[]; items: TitleCard[] }[];
  note?: string;
}

export default function ForYouPage() {
  const q = useQuery({ queryKey: ['extras-foryou'], queryFn: () => get<ForYou>('/extras/foryou'), staleTime: 10 * 60_000 });
  const { onAdd, dialog } = useQuickAdd();
  const [bulk, setBulk] = useState<{ user: string; items: TitleCard[] } | null>(null);
  if (q.isLoading) return <Spinner label="Reading watch history and finding recommendations" />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        From each Plex user's Tautulli history (last 90 days): TMDB recommendations for what they watched most and most recently, minus anything already in the library.
      </p>
      {d.note && <p className="text-sm text-muted">{d.note}</p>}
      {d.users.map((u) => (
        <div key={u.userId}>
          <Rail
            title={
              <span>
                For {u.user} <span className="text-xs text-muted font-normal">· from {u.seeds.slice(0, 3).map((s) => s.title).join(', ')}</span>
              </span>
            }
            cards={u.items}
            onAdd={onAdd}
            extra={
              u.items.length ? (
                <Button size="sm" onClick={() => setBulk({ user: u.user, items: u.items })}>
                  Select and add…
                </Button>
              ) : undefined
            }
          />
          {!u.items.length && <p className="text-sm text-muted">Nothing new to suggest for {u.user}.</p>}
        </div>
      ))}
      {dialog}
      {bulk && <BulkAddDialog open onClose={() => setBulk(null)} cards={bulk.items} title={`Add picks for ${bulk.user}`} />}
    </div>
  );
}
