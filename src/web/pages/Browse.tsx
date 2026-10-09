import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { MediaType } from '../../shared/types.ts';
import { get, qs } from '../api.ts';
import { img } from '../format.ts';
import { PagedGrid } from '../components/Paged.tsx';
import { useHideOwned } from '../prefs.ts';
import { Field, inputCls, PageHeader, Segmented, Toggle } from '../components/ui.tsx';

interface Opt {
  id: number;
  name: string;
}

/** Search-as-you-type picker whose selection lives in the URL as `<key>` (id) and `<key>Name` (label). */
function Typeahead({ label, endpoint, value, valueName, onPick }: { label: string; endpoint: string; value?: string | null; valueName?: string | null; onPick: (o: Opt | null) => void }) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const q = useQuery({ queryKey: ['ta', endpoint, debounced], queryFn: () => get<Opt[]>(`${endpoint}?q=${encodeURIComponent(debounced)}`, true), enabled: debounced.length >= 2 });
  if (value)
    return (
      <Field label={label}>
        <div className={`${inputCls} flex items-center justify-between gap-2`}>
          <span className="truncate">{valueName || value}</span>
          <button onClick={() => onPick(null)} aria-label={`Clear ${label}`} className="text-muted hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
      </Field>
    );
  return (
    <Field label={label}>
      <div className="relative">
        <input
          className={inputCls}
          value={text}
          placeholder="Type to search…"
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {open && q.data && q.data.length > 0 && (
          <ul className="absolute z-20 mt-1 w-full rounded-lg border border-line bg-surface shadow-xl max-h-64 overflow-y-auto">
            {q.data.map((o) => (
              <li key={o.id}>
                <button
                  className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onPick(o);
                    setText('');
                    setOpen(false);
                  }}
                >
                  {o.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Field>
  );
}

const DECADES = [2020, 2010, 2000, 1990, 1980, 1970, 1960, 1950, 1940, 1930, 1920];

export default function BrowsePage() {
  const [p, setP] = useSearchParams();
  const type = (p.get('type') === 'tv' ? 'tv' : 'movie') as MediaType;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setP(next, { replace: true });
  };
  const genres = useQuery({ queryKey: ['genres', type], queryFn: () => get<Opt[]>(`/meta/genres?type=${type}`), staleTime: Infinity });
  const langs = useQuery({ queryKey: ['languages'], queryFn: () => get<{ code: string; name: string }[]>('/meta/languages'), staleTime: Infinity });
  const providers = useQuery({ queryKey: ['providers', type], queryFn: () => get<{ id: number; name: string; logoPath: string }[]>(`/meta/providers?type=${type}`), staleTime: Infinity });
  const [showAllProviders, setShowAllProviders] = useState(false);
  const sortOptions =
    type === 'movie'
      ? [
          ['popularity.desc', 'Most popular'],
          ['vote_average.desc', 'Highest rated'],
          ['primary_release_date.desc', 'Newest'],
          ['revenue.desc', 'Highest grossing'],
        ]
      : [
          ['popularity.desc', 'Most popular'],
          ['vote_average.desc', 'Highest rated'],
          ['first_air_date.desc', 'Newest'],
        ];
  const filterKeys = ['genre', 'decade', 'language', 'country', 'provider', 'company', 'network', 'keyword', 'person', 'minRating', 'sort'];
  const [hide, setHide] = useHideOwned();
  const params: Record<string, string | null> = { type };
  for (const k of filterKeys) params[k] = p.get(k);
  params.hideInLibrary = hide ? '1' : null;
  const path = `/discover/browse${qs(params)}`;
  const selectedProviders = (p.get('provider') ?? '').split('|').filter(Boolean);
  const provList = providers.data ?? [];
  const shownProviders = showAllProviders ? provList : provList.slice(0, 16);

  return (
    <div>
      <PageHeader
        title="Browse"
        sub="Filter TMDB by anything; badges show what's already yours."
        actions={
          <Segmented
            value={type}
            onChange={(v) => {
              const next = new URLSearchParams();
              if (v === 'tv') next.set('type', 'tv');
              setP(next, { replace: true });
            }}
            options={[
              { value: 'movie', label: 'Movies' },
              { value: 'tv', label: 'TV' },
            ]}
          />
        }
      />
      <div className="rounded-xl border border-line bg-surface p-4 mb-5 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Field label="Sort">
            <select className={inputCls} value={p.get('sort') ?? 'popularity.desc'} onChange={(e) => set({ sort: e.target.value === 'popularity.desc' ? null : e.target.value })}>
              {sortOptions.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Genre">
            <select className={inputCls} value={p.get('genre') ?? ''} onChange={(e) => set({ genre: e.target.value || null })}>
              <option value="">Any</option>
              {genres.data?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Decade">
            <select className={inputCls} value={p.get('decade') ?? ''} onChange={(e) => set({ decade: e.target.value || null })}>
              <option value="">Any</option>
              {DECADES.map((d) => (
                <option key={d} value={d}>
                  {d}s
                </option>
              ))}
            </select>
          </Field>
          <Field label="Original language">
            <select className={inputCls} value={p.get('language') ?? ''} onChange={(e) => set({ language: e.target.value || null })}>
              <option value="">Any</option>
              {langs.data?.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Country (ISO code)">
            <input className={inputCls} placeholder="e.g. KR" maxLength={2} value={p.get('country') ?? ''} onChange={(e) => set({ country: e.target.value.toUpperCase() || null })} />
          </Field>
          <Field label="Minimum rating">
            <select className={inputCls} value={p.get('minRating') ?? ''} onChange={(e) => set({ minRating: e.target.value || null })}>
              <option value="">Any</option>
              {[5, 6, 7, 7.5, 8, 8.5].map((r) => (
                <option key={r} value={r}>
                  {r}+
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Typeahead label="Studio" endpoint="/meta/companies" value={p.get('company')} valueName={p.get('companyName')} onPick={(o) => set({ company: o ? String(o.id) : null, companyName: o?.name ?? null })} />
          {type === 'tv' ? (
            <Field label="Network id">
              <input
                className={inputCls}
                placeholder="e.g. 213 (Netflix), 49 (HBO)"
                value={p.get('network') ?? ''}
                onChange={(e) => set({ network: e.target.value.replace(/\D/g, '') || null, networkName: null })}
              />
            </Field>
          ) : (
            <Typeahead label="Person" endpoint="/meta/people" value={p.get('person')} valueName={p.get('personName')} onPick={(o) => set({ person: o ? String(o.id) : null, personName: o?.name ?? null })} />
          )}
          <Typeahead label="Keyword" endpoint="/meta/keywords" value={p.get('keyword')} valueName={p.get('keywordName')} onPick={(o) => set({ keyword: o ? String(o.id) : null, keywordName: o?.name ?? null })} />
          <div className="flex items-end pb-2">
            <Toggle checked={hide} onChange={setHide} label="Hide titles I have" />
          </div>
        </div>
        {p.get('networkName') && <p className="text-xs text-muted">Network: {p.get('networkName')}</p>}
        <div>
          <div className="text-xs text-muted mb-1.5">Streaming on ({provList.length ? 'pick any' : 'loading'})</div>
          <div className="flex flex-wrap gap-1.5">
            {shownProviders.map((pr) => {
              const on = selectedProviders.includes(String(pr.id));
              return (
                <button
                  key={pr.id}
                  title={pr.name}
                  aria-pressed={on}
                  onClick={() => {
                    const next = on ? selectedProviders.filter((x) => x !== String(pr.id)) : [...selectedProviders, String(pr.id)];
                    set({ provider: next.join('|') || null });
                  }}
                  className={`flex items-center gap-1.5 rounded-lg border px-1.5 py-1 text-xs transition ${on ? 'border-accent bg-accent/15' : 'border-line bg-surface-2 hover:bg-surface-3'}`}
                >
                  {pr.logoPath && <img src={img(pr.logoPath, 'w92')} alt="" className="size-5 rounded" loading="lazy" />}
                  <span className="max-w-28 truncate">{pr.name}</span>
                </button>
              );
            })}
            {provList.length > 16 && (
              <button className="text-xs text-accent px-2" onClick={() => setShowAllProviders(!showAllProviders)}>
                {showAllProviders ? 'Fewer' : `+${provList.length - 16} more`}
              </button>
            )}
          </div>
        </div>
        {[...p.keys()].some((k) => filterKeys.includes(k)) && (
          <button className="text-xs text-muted hover:text-fg underline" onClick={() => setP(type === 'tv' ? { type: 'tv' } : {}, { replace: true })}>
            Clear all filters
          </button>
        )}
      </div>
      <PagedGrid path={path} queryKey={['browse', path]} empty="No titles match these filters." />
    </div>
  );
}
