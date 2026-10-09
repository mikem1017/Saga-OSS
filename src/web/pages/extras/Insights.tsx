import { lazy, Suspense } from 'react';
import { NavLink, Navigate, useParams } from 'react-router';
import { ArrowUpCircle, Bot, HardDrive, Heart, Sparkles, Stethoscope } from 'lucide-react';
import { PageHeader, Spinner } from '../../components/ui.tsx';

const Upgrades = lazy(() => import('./Upgrades.tsx'));
const Storage = lazy(() => import('./Storage.tsx'));
const Hygiene = lazy(() => import('./Hygiene.tsx'));
const ForYou = lazy(() => import('./ForYou.tsx'));
const Ask = lazy(() => import('./Ask.tsx'));
const AutoBump = lazy(() => import('./AutoBump.tsx'));

const TABS = [
  { id: 'ask', label: 'Ask', icon: Sparkles, el: Ask },
  { id: 'for-you', label: 'Because you watched', icon: Heart, el: ForYou },
  { id: 'upgrades', label: 'Upgrades', icon: ArrowUpCircle, el: Upgrades },
  { id: 'storage', label: 'Storage forecast', icon: HardDrive, el: Storage },
  { id: 'hygiene', label: 'Library hygiene', icon: Stethoscope, el: Hygiene },
  { id: 'auto-bump', label: 'Auto-bump', icon: Bot, el: AutoBump },
] as const;

/** Insights hub: /insights/<tab>. Read-heavy; writes go through the usual audited endpoints. */
export default function InsightsPage() {
  const tab = useParams()['*']?.split('/')[0] || '';
  const current = TABS.find((t) => t.id === tab);
  if (!current) return <Navigate to="/insights/ask" replace />;
  const El = current.el;
  return (
    <div>
      <PageHeader title="Insights" sub="Recommendations, upgrades, storage and library health" />
      <nav className="flex gap-1 overflow-x-auto pb-2 mb-4 border-b border-line" aria-label="Insights sections">
        {TABS.map((t) => (
          <NavLink
            key={t.id}
            to={`/insights/${t.id}`}
            className={({ isActive }) => `flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-surface-3 text-fg font-medium' : 'text-muted hover:text-fg hover:bg-surface-2'}`}
          >
            <t.icon className="size-4" aria-hidden />
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Suspense fallback={<Spinner />}>
        <El />
      </Suspense>
    </div>
  );
}
