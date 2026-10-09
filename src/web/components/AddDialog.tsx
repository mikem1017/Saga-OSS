import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Zap } from 'lucide-react';
import type { AddDecision, AddPreview, AddResult, MediaType, TitleCard } from '../../shared/types.ts';
import { get, post } from '../api.ts';
import { bytes, duration, img } from '../format.ts';
import { Button, ErrorBox, Field, inputCls, Modal, Spinner, Toggle } from './ui.tsx';
import { StateBadge } from './Poster.tsx';

export interface ProfileInfo {
  id: number;
  name: string;
  upgradeAllowed?: boolean;
  cutoff?: string;
  allowed?: string[];
  scoredFormats?: number;
  cutoffFormatScore?: number;
  stock?: boolean;
}

export interface ArrMeta {
  radarr: { profiles: ProfileInfo[]; roots: { id: number; path: string; freeSpace?: number }[]; defaultProfile: string | null };
  sonarr: { profiles: ProfileInfo[]; roots: { id: number; path: string; freeSpace?: number }[]; defaultProfile: string | null };
}

/** One-line description of a profile as configured in the *arr. */
export function profileSummary(p: ProfileInfo): string {
  if (p.stock) return 'stock profile: no custom formats, no upgrades';
  const parts = [`${p.scoredFormats ?? 0} custom formats`, p.upgradeAllowed ? `upgrades to ${p.cutoff ?? 'cutoff'}` : 'no upgrades'];
  if (p.cutoffFormatScore) parts.push(`score cutoff ${p.cutoffFormatScore.toLocaleString()}`);
  return parts.join(' · ');
}

export type Overrides = Partial<Pick<AddDecision, 'qualityProfileId' | 'rootFolderPath' | 'monitor' | 'minimumAvailability' | 'seriesType' | 'searchNow' | 'bumpOnGrab' | 'seasons'>>;

export function useArrMeta() {
  return useQuery({ queryKey: ['meta-arr'], queryFn: () => get<ArrMeta>('/meta/arr'), staleTime: 10 * 60_000 });
}

const MONITOR_OPTIONS: { value: AddDecision['monitor']; label: string }[] = [
  { value: 'all', label: 'All episodes' },
  { value: 'future', label: 'Future episodes only' },
  { value: 'missing', label: 'Missing episodes' },
  { value: 'existing', label: 'Existing episodes' },
  { value: 'firstSeason', label: 'First season' },
  { value: 'lastSeason', label: 'Latest season' },
  { value: 'pilot', label: 'Pilot only' },
  { value: 'none', label: 'None (add unmonitored)' },
];

/** Editable fields of an add decision. `base` is what the rules chose; `value` holds only the admin's edits. */
export function DecisionForm({
  mediaType,
  base,
  value,
  onChange,
  compact,
  resolved,
}: {
  mediaType: MediaType | 'mixed';
  base?: AddDecision;
  value: Overrides;
  onChange: (o: Overrides) => void;
  compact?: boolean;
  /** What "Per rule" actually resolves to (from a preview), for bulk adds. */
  resolved?: { profiles: string[]; roots: string[] };
}) {
  const meta = useArrMeta();
  const arr = mediaType === 'movie' ? meta.data?.radarr : mediaType === 'tv' ? meta.data?.sonarr : undefined;
  // Before a preview, "Per rule" means the default: the configured profile (or the most-tuned one) and the first root folder.
  const defaultProfile = arr
    ? (arr.profiles.find((p) => p.name === arr.defaultProfile) ?? [...arr.profiles].sort((a, b) => (b.scoredFormats ?? 0) - (a.scoredFormats ?? 0))[0])?.name
    : undefined;
  const perRule = (values: string[] | undefined, fallback: string | undefined) =>
    values?.length ? `Per rule (${values.length > 2 ? `${values.length} different` : values.join(', ')})` : fallback ? `Per rule (${fallback} unless a rule says otherwise)` : 'Per rule';
  const cur = <K extends keyof Overrides>(k: K, fallback: NonNullable<Overrides[K]>) => (value[k] ?? (base?.[k as keyof AddDecision] as Overrides[K]) ?? fallback) as NonNullable<Overrides[K]>;
  const set = (patch: Overrides) => onChange({ ...value, ...patch });
  return (
    <div className={`grid gap-3 ${compact ? 'sm:grid-cols-2' : 'sm:grid-cols-2'}`}>
      {arr && (
        <>
          <Field label="Quality profile">
            <select className={inputCls} value={cur('qualityProfileId', 0)} onChange={(e) => set({ qualityProfileId: Number(e.target.value) })}>
              {!base && !value.qualityProfileId && <option value={0}>{perRule(resolved?.profiles, defaultProfile)}</option>}
              <optgroup label="Tuned (your Radarr/Sonarr profiles)">
                {arr.profiles
                  .filter((p) => !p.stock)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Stock (not recommended)">
                {arr.profiles
                  .filter((p) => p.stock)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} (stock)
                    </option>
                  ))}
              </optgroup>
            </select>
            {(() => {
              const p = arr.profiles.find((x) => x.id === cur('qualityProfileId', 0));
              if (!p) return null;
              return (
                <span className={`block mt-1 text-[11px] ${p.stock ? 'text-warn' : 'text-muted'}`} title={p.allowed?.join(', ')}>
                  {profileSummary(p)}
                </span>
              );
            })()}
          </Field>
          <Field label="Root folder">
            <select className={inputCls} value={cur('rootFolderPath', '')} onChange={(e) => set({ rootFolderPath: e.target.value || undefined })}>
              {!base && !value.rootFolderPath && <option value="">{perRule(resolved?.roots, arr.roots[0]?.path)}</option>}
              {arr.roots.map((r) => (
                <option key={r.id} value={r.path}>
                  {r.path}
                  {r.freeSpace ? ` (${bytes(r.freeSpace)} free)` : ''}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      {mediaType === 'movie' && (
        <Field label="Minimum availability">
          <select className={inputCls} value={cur('minimumAvailability', 'released')} onChange={(e) => set({ minimumAvailability: e.target.value as AddDecision['minimumAvailability'] })}>
            <option value="announced">Announced</option>
            <option value="inCinemas">In cinemas</option>
            <option value="released">Released</option>
          </select>
        </Field>
      )}
      {mediaType === 'tv' && (
        <>
          <Field label="Monitor">
            <select
              className={inputCls}
              value={value.seasons ? 'custom' : cur('monitor', 'all')}
              disabled={!!value.seasons}
              onChange={(e) => set({ monitor: e.target.value as AddDecision['monitor'] })}
            >
              {value.seasons && <option value="custom">Selected seasons</option>}
              {MONITOR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Series type">
            <select className={inputCls} value={cur('seriesType', 'standard')} onChange={(e) => set({ seriesType: e.target.value as AddDecision['seriesType'] })}>
              <option value="standard">Standard</option>
              <option value="anime">Anime</option>
              <option value="daily">Daily</option>
            </select>
          </Field>
        </>
      )}
      <div className="sm:col-span-2 flex flex-wrap gap-x-6 gap-y-2 pt-1">
        <Toggle checked={cur('searchNow', true)} onChange={(v) => set({ searchNow: v })} label="Search now" />
        <Toggle
          checked={cur('bumpOnGrab', false)}
          onChange={(v) => set({ bumpOnGrab: v })}
          label={
            <span>
              Bump to top when grabbed <span className="text-muted text-xs">(top of the High band)</span>
            </span>
          }
        />
      </div>
    </div>
  );
}

function PreviewSummary({ p }: { p: AddPreview }) {
  const kinds = p.items.filter((i) => !i.alreadyInLibrary);
  const movies = kinds.filter((i) => i.mediaType === 'movie').length;
  const shows = kinds.length - movies;
  const what = [movies && `${movies} movie${movies === 1 ? '' : 's'}`, shows && `${shows} show${shows === 1 ? '' : 's'}`].filter(Boolean).join(' + ') || 'nothing new';
  return (
    <div className="rounded-xl bg-surface-2 border border-line p-3 text-sm space-y-1">
      <div className="font-medium">
        This adds {what}, ~{bytes(p.totalBytes, 0)}.
      </div>
      <div className="text-muted">
        Queue ETA: ~{duration(p.etaBackSec)} at the back of the queue ({bytes(p.queueBytesAhead, 1)} ahead) · ~{duration(p.etaBumpedSec)} if bumped.
        {p.rateBps ? ` Based on ${bytes(p.rateBps)}/s effective.` : ' No throughput measured yet.'}
      </div>
    </div>
  );
}

function Results({ results }: { results: AddResult[] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {results.map((r) => (
        <li key={`${r.mediaType}:${r.tmdbId}`} className="flex items-start gap-2">
          {r.ok ? <CheckCircle2 className="size-4 text-ok mt-0.5 shrink-0" /> : <XCircle className="size-4 text-bad mt-0.5 shrink-0" />}
          <span>
            <span className="font-medium">{r.title}</span> — <span className={r.ok ? 'text-muted' : 'text-bad'}>{r.message}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface SeasonInfo {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  airDate?: string;
  posterPath?: string | null;
}

/** Single-title add: shows the rule that fired, lets the admin override, previews size + ETA, then adds. */
export function AddDialog({
  open,
  onClose,
  mediaType,
  tmdbId,
  title,
  seasons,
  librarySeasons,
  initialSeasons,
}: {
  open: boolean;
  onClose: () => void;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  seasons?: SeasonInfo[];
  librarySeasons?: { seasonNumber: number; monitored: boolean; have: number; total: number }[];
  initialSeasons?: number[] | null;
}) {
  const qc = useQueryClient();
  const [ov, setOv] = useState<Overrides>({});
  const [results, setResults] = useState<AddResult[] | null>(null);
  useEffect(() => {
    if (open) {
      setOv(initialSeasons ? { seasons: initialSeasons } : {});
      setResults(null);
    }
  }, [open, tmdbId, initialSeasons]);

  const decision = useQuery({
    queryKey: ['decision', mediaType, tmdbId],
    queryFn: () => get<AddDecision>(`/add/decision?type=${mediaType}&id=${tmdbId}`),
    enabled: open,
  });
  const ovKey = JSON.stringify(ov);
  const preview = useQuery({
    queryKey: ['preview', mediaType, tmdbId, ovKey],
    queryFn: () => post<AddPreview>('/add/preview', { items: [{ mediaType, tmdbId, overrides: ov }] }, true),
    enabled: open && decision.isSuccess,
    staleTime: 30_000,
  });
  const add = useMutation({
    mutationFn: () => post<AddResult[]>('/add', { items: [{ mediaType, tmdbId, overrides: ov }] }),
    onSuccess: (r) => {
      setResults(r);
      setTimeout(() => qc.invalidateQueries(), 1500);
    },
  });
  const item = preview.data?.items[0];
  const inLibrarySeasons = new Map((librarySeasons ?? []).map((s) => [s.seasonNumber, s]));
  const regularSeasons = (seasons ?? []).filter((s) => s.seasonNumber > 0 || (seasons ?? []).length === 1);

  return (
    <Modal open={open} onClose={onClose} title={`Add ${title}`}>
      {decision.isLoading && <Spinner label="Working out the rules" />}
      {decision.error && <ErrorBox error={decision.error} />}
      {decision.data && !results && (
        <div className="space-y-4">
          <div className="text-sm flex items-center gap-2">
            <Zap className="size-4 text-accent" />
            <span>
              Rule: <span className="font-medium">{preview.data?.items[0]?.decision.ruleName ?? decision.data.ruleName}</span>
            </span>
          </div>
          <DecisionForm mediaType={mediaType} base={decision.data} value={ov} onChange={setOv} />
          {mediaType === 'tv' && regularSeasons.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-muted">Seasons {librarySeasons ? '(add more to an existing show)' : ''}</span>
                <div className="flex gap-2">
                  <button className="text-xs text-accent" onClick={() => setOv({ ...ov, seasons: regularSeasons.map((s) => s.seasonNumber) })}>
                    All
                  </button>
                  <button className="text-xs text-muted hover:text-fg" onClick={() => setOv({ ...ov, seasons: null })}>
                    Use monitor option
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {regularSeasons.map((s) => {
                  const lib = inLibrarySeasons.get(s.seasonNumber);
                  const checked = ov.seasons?.includes(s.seasonNumber) ?? false;
                  return (
                    <label key={s.seasonNumber} className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm cursor-pointer ${checked ? 'border-accent bg-accent/10' : 'border-line bg-surface-2'}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const set = new Set(ov.seasons ?? []);
                          if (e.target.checked) set.add(s.seasonNumber);
                          else set.delete(s.seasonNumber);
                          setOv({ ...ov, seasons: set.size ? [...set].sort((a, b) => a - b) : null });
                        }}
                      />
                      <span className="truncate">
                        {s.name}
                        <span className="text-muted text-xs">
                          {' '}
                          · {s.episodeCount} ep{lib ? ` · have ${lib.have}${lib.monitored ? '' : ', unmon.'}` : ''}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          {preview.isFetching && !preview.data && <Spinner label="Estimating size and ETA" />}
          {preview.error && <ErrorBox error={preview.error} />}
          {preview.data && (
            <>
              <PreviewSummary p={preview.data} />
              {item && <div className="text-xs text-muted">Size estimate: {item.estBasis}</div>}
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" busy={add.isPending} onClick={() => add.mutate()} disabled={!!item?.alreadyInLibrary && !ov.seasons?.length}>
              {item?.alreadyInLibrary && !ov.seasons?.length ? 'Already in library' : 'Add'}
            </Button>
          </div>
        </div>
      )}
      {results && (
        <div className="space-y-4">
          <Results results={results} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Bulk add from a collection, person, list or search: missing titles pre-selected, shared overrides, one preview. */
export function BulkAddDialog({ open, onClose, onDone, cards, title }: { open: boolean; onClose: () => void; onDone?: () => void; cards: TitleCard[]; title: string }) {
  const qc = useQueryClient();
  const candidates = useMemo(() => cards.filter((c) => c.state.kind === 'none' || c.state.kind === 'requested'), [cards]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ov, setOv] = useState<Overrides>({});
  const [results, setResults] = useState<AddResult[] | null>(null);
  const key = (c: TitleCard) => `${c.mediaType}:${c.tmdbId}`;
  useEffect(() => {
    if (open) {
      setSelected(new Set(candidates.slice(0, 250).map(key)));
      setOv({});
      setResults(null);
    }
  }, [open, candidates]);

  const chosen = candidates.filter((c) => selected.has(key(c)));
  const types = new Set(chosen.map((c) => c.mediaType));
  const formType: MediaType | 'mixed' = types.size === 1 ? [...types][0]! : 'mixed';
  const cleanOv: Overrides =
    formType === 'mixed' ? { searchNow: ov.searchNow, bumpOnGrab: ov.bumpOnGrab } : { ...ov };
  for (const k of Object.keys(cleanOv) as (keyof Overrides)[]) if (cleanOv[k] === undefined) delete cleanOv[k];
  const items = chosen.map((c) => ({ mediaType: c.mediaType, tmdbId: c.tmdbId, overrides: cleanOv }));
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const curKey = JSON.stringify(items);
  const preview = useQuery({
    queryKey: ['bulk-preview', previewKey],
    queryFn: () => post<AddPreview>('/add/preview', { items: JSON.parse(previewKey!) }, true),
    enabled: open && !!previewKey && previewKey !== '[]',
    staleTime: 60_000,
  });
  // More than a handful of titles runs as a background job on the server; poll it for progress.
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useQuery({
    queryKey: ['add-job', jobId],
    queryFn: () => get<{ total: number; results: AddResult[]; done: boolean }>(`/add/jobs/${jobId}`, true),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.done ? false : 1500),
  });
  useEffect(() => {
    if (job.data?.done) {
      setResults(job.data.results);
      onDone?.();
      setTimeout(() => qc.invalidateQueries(), 1500);
    }
  }, [job.data?.done]);
  const add = useMutation({
    mutationFn: async () => {
      if (items.length <= 5) return post<AddResult[]>('/add', { items });
      const j = await post<{ id: string }>('/add/jobs', { items });
      setJobId(j.id);
      return null;
    },
    onSuccess: (r) => {
      if (!r) return;
      setResults(r);
      onDone?.();
      setTimeout(() => qc.invalidateQueries(), 1500);
    },
  });
  const adding = add.isPending || (!!jobId && !job.data?.done);
  const byKey = new Map((preview.data?.items ?? []).map((i) => [`${i.mediaType}:${i.tmdbId}`, i]));
  const stale = previewKey !== curKey;

  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      {!results ? (
        <div className="space-y-4">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted">Everything here is already in the library.</p>
          ) : (
            <>
              <div className="flex items-center justify-between text-sm">
                <span>
                  {chosen.length} of {candidates.length} missing selected
                  {candidates.length > 250 && <span className="text-warn"> (max 250 per add)</span>}
                </span>
                <div className="flex gap-3">
                  <button className="text-accent text-xs" onClick={() => setSelected(new Set(candidates.slice(0, 250).map(key)))}>
                    Select all
                  </button>
                  <button className="text-muted text-xs hover:text-fg" onClick={() => setSelected(new Set())}>
                    None
                  </button>
                </div>
              </div>
              <ul className="max-h-[38vh] overflow-y-auto divide-y divide-line rounded-xl border border-line">
                {candidates.map((c) => {
                  const p = byKey.get(key(c));
                  return (
                    <li key={key(c)}>
                      <label className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-surface-2">
                        <input
                          type="checkbox"
                          checked={selected.has(key(c))}
                          onChange={(e) => {
                            const s = new Set(selected);
                            if (e.target.checked) s.add(key(c));
                            else s.delete(key(c));
                            setSelected(s);
                          }}
                        />
                        {c.posterPath ? <img src={img(c.posterPath, 'w92')} alt="" className="w-8 h-12 object-cover rounded" loading="lazy" /> : <div className="w-8 h-12 rounded bg-surface-3" />}
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm truncate">
                            {c.title} <span className="text-muted">{c.year}</span> {c.mediaType === 'tv' && <span className="text-xs text-muted">· TV</span>}
                          </span>
                          {p && !stale && (
                            <span className="block text-xs text-muted truncate">
                              {p.decision.ruleName} · {p.decision.qualityProfileName} · ~{bytes(p.estBytes, 0)}
                            </span>
                          )}
                        </span>
                        <StateBadge state={c.state} />
                      </label>
                    </li>
                  );
                })}
              </ul>
              <DecisionForm
                mediaType={formType}
                value={ov}
                onChange={setOv}
                compact
                resolved={
                  preview.data && !stale
                    ? {
                        profiles: [...new Set(preview.data.items.map((i) => i.decision.qualityProfileName))],
                        roots: [...new Set(preview.data.items.map((i) => i.decision.rootFolderPath))],
                      }
                    : undefined
                }
              />
              {formType === 'mixed' && <p className="text-xs text-muted">Mixed movies and TV: quality and folders follow each title's rules.</p>}
              <div className="flex items-center gap-2">
                <Button onClick={() => setPreviewKey(curKey)} disabled={!chosen.length} busy={preview.isFetching}>
                  {preview.data && !stale ? 'Re-check' : 'Preview size and ETA'}
                </Button>
                {preview.isFetching && <span className="text-xs text-muted">Checking {chosen.length} titles…</span>}
              </div>
              {preview.error && <ErrorBox error={preview.error} />}
              {preview.data && !stale && <PreviewSummary p={preview.data} />}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button variant="primary" disabled={!chosen.length || stale || !preview.data} busy={adding} onClick={() => add.mutate()}>
                  Add {chosen.length}
                </Button>
              </div>
              {jobId && job.data && !job.data.done && (
                <div className="space-y-1">
                  <div className="text-xs text-muted">
                    Adding {job.data.results.length} of {job.data.total}… (one at a time, to be gentle with Radarr/Sonarr)
                  </div>
                  <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
                    <div className="h-full bg-accent transition-all" style={{ width: `${(job.data.results.length / job.data.total) * 100}%` }} />
                  </div>
                </div>
              )}
              {(stale || !preview.data) && chosen.length > 0 && <p className="text-xs text-muted text-right">Preview first to see the size and queue ETA.</p>}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm">
            {results.filter((r) => r.ok).length} added, {results.filter((r) => !r.ok).length} failed.
          </p>
          <Results results={results} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Hook for pages: a quick-add button handler + the dialog element. */
export function useQuickAdd() {
  const [target, setTarget] = useState<TitleCard | null>(null);
  const dialog = target ? (
    <AddDialog open={!!target} onClose={() => setTarget(null)} mediaType={target.mediaType} tmdbId={target.tmdbId} title={target.title} />
  ) : null;
  return { onAdd: (c: TitleCard) => setTarget(c), dialog };
}
