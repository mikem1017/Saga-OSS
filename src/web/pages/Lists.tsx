import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListPlus, Trash2 } from 'lucide-react';
import { del, get, post } from '../api.ts';
import { Button, Card, ErrorBox, inputCls, PageHeader, Spinner } from '../components/ui.tsx';
import { useToast } from '../components/toast.tsx';

export interface SavedList {
  id: number;
  builtin: boolean;
  kind: string;
  ref: string;
  name: string;
}

export const listHref = (l: { kind: string; ref: string }) => `/lists/view?url=${encodeURIComponent(l.ref)}&kind=${l.kind}`;

const KIND_LABEL: Record<string, string> = { imdb: 'IMDb', letterboxd: 'Letterboxd', mdblist: 'MDBList', tmdb: 'TMDB', trakt: 'Trakt' };

export default function ListsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const lists = useQuery({ queryKey: ['lists'], queryFn: () => get<SavedList[]>('/lists') });
  const [url, setUrl] = useState('');
  const add = useMutation({
    mutationFn: () => post<{ ok: boolean; name: string }>('/lists', { url: url.trim() }),
    onSuccess: (r) => {
      toast(`Saved “${r.name}”`, 'ok');
      setUrl('');
      void qc.invalidateQueries({ queryKey: ['lists'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/lists/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lists'] }),
  });

  return (
    <div>
      <PageHeader title="Lists" sub="See how much of any list you have, then add everything missing in one go." />
      <Card title="Add a list" className="mb-5">
        <form
          className="flex flex-col sm:flex-row gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) add.mutate();
          }}
        >
          <input
            className={inputCls}
            type="url"
            required
            placeholder="https://letterboxd.com/user/list/… · imdb.com/list/ls… · mdblist.com/lists/… · themoviedb.org/list/… · trakt.tv/users/…/lists/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="List URL"
          />
          <Button variant="primary" type="submit" busy={add.isPending} className="shrink-0">
            <ListPlus className="size-4" /> Save list
          </Button>
        </form>
        {add.isPending && <p className="text-xs text-muted mt-2">Reading the list and matching every title to TMDB; a large list can take ~30 s the first time.</p>}
        <p className="text-xs text-muted mt-2">Trakt needs a Trakt client id on the server. Letterboxd lists are read from the public page.</p>
      </Card>
      {lists.isLoading && <Spinner />}
      {lists.error && <ErrorBox error={lists.error} />}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {lists.data?.map((l) => (
          <div key={`${l.kind}:${l.ref}`} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
            <Link to={listHref(l)} className="flex-1 min-w-0 group">
              <div className="font-medium truncate group-hover:text-accent">{l.name}</div>
              <div className="text-xs text-muted truncate">
                {KIND_LABEL[l.kind] ?? l.kind}
                {l.builtin ? ' · built in' : ''}
              </div>
            </Link>
            {!l.builtin && (
              <button
                className="p-1.5 rounded-lg text-muted hover:text-bad hover:bg-surface-2"
                aria-label={`Remove ${l.name}`}
                onClick={() => {
                  if (confirm(`Remove “${l.name}” from saved lists?`)) remove.mutate(l.id);
                }}
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
