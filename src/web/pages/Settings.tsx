import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, LogOut, Plus, Save, Trash2 } from 'lucide-react';
import type { AddRule, RuleActions, RuleConditions } from '../../shared/types.ts';
import { get, post, put, setCsrf } from '../api.ts';
import { useAuth } from '../App.tsx';
import { useArrMeta } from '../components/AddDialog.tsx';
import { Button, Card, ErrorBox, Field, inputCls, PageHeader, Spinner, Toggle } from '../components/ui.tsx';
import { useToast } from '../components/toast.tsx';

type DraftRule = Omit<AddRule, 'id' | 'position'> & { key: number };

let keySeq = 1;
const list = (v?: string[]) => (v ?? []).join(', ');
const parseList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function clean<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'number' && Number.isNaN(v))) continue;
    out[k] = v;
  }
  return out as T;
}

function RuleEditor({ rule, onChange, onRemove, onMove, first, last }: { rule: DraftRule; onChange: (r: DraftRule) => void; onRemove: () => void; onMove: (d: -1 | 1) => void; first: boolean; last: boolean }) {
  const meta = useArrMeta();
  const arr = rule.mediaType === 'movie' ? meta.data?.radarr : rule.mediaType === 'tv' ? meta.data?.sonarr : undefined;
  const c = rule.conditions;
  const a = rule.actions;
  const setC = (patch: Partial<RuleConditions>) => onChange({ ...rule, conditions: clean({ ...c, ...patch }) });
  const setA = (patch: Partial<RuleActions>) => onChange({ ...rule, actions: clean({ ...a, ...patch }) });
  const optBool = (v: boolean | undefined) => (v === undefined ? '' : v ? 'yes' : 'no');
  const parseBool = (s: string) => (s === '' ? undefined : s === 'yes');
  return (
    <div className={`rounded-xl border p-4 space-y-3 ${rule.enabled ? 'border-line bg-surface' : 'border-line/50 bg-surface/50 opacity-75'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputCls} flex-1 min-w-[12rem] font-medium`} value={rule.name} onChange={(e) => onChange({ ...rule, name: e.target.value })} aria-label="Rule name" />
        <select className={`${inputCls} w-auto`} value={rule.mediaType} onChange={(e) => onChange({ ...rule, mediaType: e.target.value as DraftRule['mediaType'], actions: clean({ ...a, qualityProfileId: undefined, rootFolderPath: undefined }) })} aria-label="Applies to">
          <option value="movie">Movies</option>
          <option value="tv">TV</option>
          <option value="any">Movies + TV</option>
        </select>
        <Toggle checked={rule.enabled} onChange={(v) => onChange({ ...rule, enabled: v })} label="Enabled" />
        <div className="flex gap-1 ml-auto">
          <Button size="sm" variant="ghost" disabled={first} onClick={() => onMove(-1)} aria-label="Move up">
            <ArrowUp className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" disabled={last} onClick={() => onMove(1)} aria-label="Move down">
            <ArrowDown className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onRemove} aria-label="Delete rule">
            <Trash2 className="size-4 text-bad" />
          </Button>
        </div>
      </div>
      <div>
        <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">When (all must match)</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Genre is any of">
            <input className={inputCls} placeholder="Kids, Family" defaultValue={list(c.genresAny)} onBlur={(e) => setC({ genresAny: parseList(e.target.value) })} />
          </Field>
          <Field label="Genre is none of">
            <input className={inputCls} placeholder="Documentary" defaultValue={list(c.genresNone)} onBlur={(e) => setC({ genresNone: parseList(e.target.value) })} />
          </Field>
          <Field label="US rating is one of">
            <input className={inputCls} placeholder="G, PG, TV-Y, TV-Y7" defaultValue={list(c.certificationIn)} onBlur={(e) => setC({ certificationIn: parseList(e.target.value) })} />
          </Field>
          <Field label="Original language (ISO codes)">
            <input className={inputCls} placeholder="ja, ko" defaultValue={list(c.languageIn)} onBlur={(e) => setC({ languageIn: parseList(e.target.value) })} />
          </Field>
          <Field label="Year from">
            <input className={inputCls} type="number" defaultValue={c.yearMin ?? ''} onBlur={(e) => setC({ yearMin: e.target.value ? Number(e.target.value) : undefined })} />
          </Field>
          <Field label="Year to">
            <input className={inputCls} type="number" defaultValue={c.yearMax ?? ''} onBlur={(e) => setC({ yearMax: e.target.value ? Number(e.target.value) : undefined })} />
          </Field>
        </div>
      </div>
      <div>
        <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Then set (blank = leave as is)</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {arr ? (
            <>
              <Field label="Quality profile">
                <select className={inputCls} value={a.qualityProfileId ?? ''} onChange={(e) => setA({ qualityProfileId: e.target.value ? Number(e.target.value) : undefined })}>
                  <option value="">—</option>
                  {arr.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.stock ? ' (stock: no custom formats)' : ` (${p.scoredFormats ?? 0} custom formats)`}
                    </option>
                  ))}
                </select>
                {arr.profiles.find((p) => p.id === a.qualityProfileId)?.stock && (
                  <span className="block mt-1 text-[11px] text-warn">Stock profile: no custom formats, so lower quality than a tuned profile.</span>
                )}
              </Field>
              <Field label="Root folder">
                <select className={inputCls} value={a.rootFolderPath ?? ''} onChange={(e) => setA({ rootFolderPath: e.target.value || undefined })}>
                  <option value="">—</option>
                  {arr.roots.map((r) => (
                    <option key={r.id} value={r.path}>
                      {r.path}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <p className="text-xs text-muted sm:col-span-2 self-center">Pick Movies or TV to set a quality profile or root folder.</p>
          )}
          {rule.mediaType !== 'movie' && (
            <>
              <Field label="Monitor">
                <select className={inputCls} value={a.monitor ?? ''} onChange={(e) => setA({ monitor: (e.target.value || undefined) as RuleActions['monitor'] })}>
                  <option value="">—</option>
                  {['all', 'future', 'missing', 'existing', 'firstSeason', 'lastSeason', 'pilot', 'none'].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Series type">
                <select className={inputCls} value={a.seriesType ?? ''} onChange={(e) => setA({ seriesType: (e.target.value || undefined) as RuleActions['seriesType'] })}>
                  <option value="">—</option>
                  <option value="standard">standard</option>
                  <option value="anime">anime</option>
                  <option value="daily">daily</option>
                </select>
              </Field>
            </>
          )}
          {rule.mediaType !== 'tv' && (
            <Field label="Minimum availability">
              <select className={inputCls} value={a.minimumAvailability ?? ''} onChange={(e) => setA({ minimumAvailability: (e.target.value || undefined) as RuleActions['minimumAvailability'] })}>
                <option value="">—</option>
                <option value="announced">announced</option>
                <option value="inCinemas">inCinemas</option>
                <option value="released">released</option>
              </select>
            </Field>
          )}
          <Field label="Search now">
            <select className={inputCls} value={optBool(a.searchNow)} onChange={(e) => setA({ searchNow: parseBool(e.target.value) })}>
              <option value="">—</option>
              <option value="yes">yes</option>
              <option value="no">no</option>
            </select>
          </Field>
          <Field label="Bump to top when grabbed">
            <select className={inputCls} value={optBool(a.bumpOnGrab)} onChange={(e) => setA({ bumpOnGrab: parseBool(e.target.value) })}>
              <option value="">—</option>
              <option value="yes">yes</option>
              <option value="no">no</option>
            </select>
          </Field>
        </div>
      </div>
    </div>
  );
}

function RulesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['rules'], queryFn: () => get<AddRule[]>('/rules') });
  const [draft, setDraft] = useState<DraftRule[] | null>(null);
  useEffect(() => {
    if (q.data && draft === null) setDraft(q.data.map((r) => ({ key: keySeq++, name: r.name, enabled: r.enabled, mediaType: r.mediaType, conditions: r.conditions, actions: r.actions })));
  }, [q.data, draft]);
  const save = useMutation({
    mutationFn: () => put<AddRule[]>('/rules', { rules: draft!.map(({ key: _k, ...r }) => r) }),
    onSuccess: (rules) => {
      qc.setQueryData(['rules'], rules);
      setDraft(rules.map((r) => ({ key: keySeq++, name: r.name, enabled: r.enabled, mediaType: r.mediaType, conditions: r.conditions, actions: r.actions })));
      void qc.invalidateQueries({ queryKey: ['decision'] });
      toast('Rules saved', 'ok');
    },
  });
  const dirty = draft && q.data && JSON.stringify(draft.map(({ key: _k, ...r }) => r)) !== JSON.stringify(q.data.map(({ id: _i, position: _p, ...r }) => r));
  return (
    <Card
      title="Add rules"
      actions={
        <>
          <Button
            size="sm"
            onClick={() => setDraft([...(draft ?? []), { key: keySeq++, name: 'New rule', enabled: true, mediaType: 'movie', conditions: {}, actions: {} }])}
          >
            <Plus className="size-3.5" /> Rule
          </Button>
          <Button size="sm" variant="primary" disabled={!dirty} busy={save.isPending} onClick={() => save.mutate()}>
            <Save className="size-3.5" /> Save
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted mb-4">
        One-click adds start from the defaults (DEFAULT_MOVIE_PROFILE / DEFAULT_TV_PROFILE, else the most tuned profile; first root folder; search now). Rules then run top to bottom and <em>stack</em>: each matching rule overrides only the fields it
        sets, and the add dialog names every rule that fired. You can still change anything before confirming.
      </p>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      <div className="space-y-3">
        {draft?.map((r, i) => (
          <RuleEditor
            key={r.key}
            rule={r}
            first={i === 0}
            last={i === draft.length - 1}
            onChange={(nr) => setDraft(draft.map((x) => (x.key === r.key ? nr : x)))}
            onRemove={() => setDraft(draft.filter((x) => x.key !== r.key))}
            onMove={(d) => {
              const next = [...draft];
              const [it] = next.splice(i, 1);
              next.splice(i + d, 0, it!);
              setDraft(next);
            }}
          />
        ))}
        {draft?.length === 0 && <p className="text-sm text-muted">No rules: every add uses the defaults.</p>}
      </div>
    </Card>
  );
}

function AccountCard() {
  const { me, setMe } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = useMutation({
    mutationFn: () => post('/auth/password', { current, next }),
    onSuccess: () => {
      toast('Password changed; other sessions were signed out.', 'ok');
      setCurrent('');
      setNext('');
    },
  });
  const logout = useMutation({
    mutationFn: () => post('/auth/logout'),
    onSettled: () => {
      setCsrf(null);
      setMe(null);
    },
  });
  return (
    <Card
      title="Account"
      actions={
        <Button size="sm" variant="ghost" onClick={() => logout.mutate()} busy={logout.isPending}>
          <LogOut className="size-3.5" /> Sign out
        </Button>
      }
    >
      <p className="text-sm mb-3">
        Signed in as <span className="font-medium">{me?.username}</span> ({me?.role}).
      </p>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-end"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
      >
        <Field label="Current password">
          <input className={inputCls} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label="New password (12+ characters)">
          <input className={inputCls} type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} required />
        </Field>
        <Button type="submit" busy={change.isPending} disabled={next.length < 12 || !current}>
          Change
        </Button>
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="Settings" />
      <RulesCard />
      <AccountCard />
    </div>
  );
}
