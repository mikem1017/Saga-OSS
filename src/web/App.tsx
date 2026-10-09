import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Activity, Boxes, CalendarDays, Compass, Download, Gauge, Inbox, Lightbulb, List, Pause, Search, Server, Settings, SlidersHorizontal, Users } from 'lucide-react';
import type { DownloadsSnapshot, Me } from '../shared/types.ts';
import { fetchMe, get, setUnauthorizedHandler } from './api.ts';
import { rate } from './format.ts';
import { Spinner } from './components/ui.tsx';
import LoginPage from './pages/Login.tsx';
import { SelectionProvider } from './components/Selection.tsx';
import DiscoverPage from './pages/Discover.tsx';

const BrowsePage = lazy(() => import('./pages/Browse.tsx'));
const TitlePage = lazy(() => import('./pages/Title.tsx'));
const CollectionPage = lazy(() => import('./pages/Collection.tsx'));
const PersonPage = lazy(() => import('./pages/Person.tsx'));
const SearchPage = lazy(() => import('./pages/Search.tsx'));
const ListsPage = lazy(() => import('./pages/Lists.tsx'));
const ListViewPage = lazy(() => import('./pages/ListView.tsx'));
const DownloadsPage = lazy(() => import('./pages/Downloads.tsx'));
const DashboardPage = lazy(() => import('./pages/Dashboard.tsx'));
const CalendarPage = lazy(() => import('./pages/Calendar.tsx'));
const ActivityPage = lazy(() => import('./pages/ActivityLog.tsx'));
const SettingsPage = lazy(() => import('./pages/Settings.tsx'));
const RailPage = lazy(() => import('./pages/RailAll.tsx'));
const ProvidersPage = lazy(() => import('./pages/Providers.tsx'));
const InsightsPage = lazy(() => import('./pages/extras/Insights.tsx'));
const RequestsPage = lazy(() => import('./pages/Requests.tsx'));
const GuestsPage = lazy(() => import('./pages/Guests.tsx'));
const StackPage = lazy(() => import('./pages/Stack.tsx'));

interface AuthCtx {
  me: Me | null;
  setMe: (m: Me | null) => void;
}
const Auth = createContext<AuthCtx>({ me: null, setMe: () => {} });
export const useAuth = () => useContext(Auth);

const NAV = [
  { to: '/', label: 'Discover', icon: Compass, end: true },
  { to: '/browse', label: 'Browse', icon: SlidersHorizontal },
  { to: '/lists', label: 'Lists', icon: List },
  { to: '/downloads', label: 'Downloads', icon: Download },
  { to: '/dashboard', label: 'Dashboard', icon: Gauge },
  { to: '/stack', label: 'Stack', icon: Boxes },
  { to: '/insights', label: 'Insights', icon: Lightbulb },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/providers', label: 'Providers', icon: Server },
  { to: '/requests', label: 'Requests', icon: Inbox },
  { to: '/guests', label: 'Guests', icon: Users },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/settings', label: 'Settings', icon: Settings },
];
const MOBILE_NAV = ['/', '/browse', '/downloads', '/dashboard', '/settings'];

function AuthGate({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    fetchMe().then(setMe);
    setUnauthorizedHandler(() => {
      setMe(null);
    });
  }, []);
  useEffect(() => {
    if (me === null && location.pathname !== '/login') navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
  }, [me, location.pathname, location.search, navigate]);
  if (me === undefined) return <Spinner label="Starting Saga" />;
  return <Auth.Provider value={{ me, setMe }}>{children}</Auth.Provider>;
}

function SearchBox() {
  const navigate = useNavigate();
  const location = useLocation();
  const ref = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (location.pathname === '/search') setQ(new URLSearchParams(location.search).get('q') ?? '');
  }, [location.pathname, location.search]);
  return (
    <form
      role="search"
      className="relative flex-1 max-w-xl"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
      }}
    >
      <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
      <input
        ref={ref}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search titles or paste a link"
        placeholder="Search, or paste an IMDb / TMDB / TVDB / Trakt / Letterboxd link"
        className="w-full rounded-xl bg-surface-2 border border-line pl-9 pr-14 py-2 text-sm outline-none focus:border-accent"
      />
      <kbd className="hidden md:block absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted border border-line rounded px-1.5 py-0.5">⌘K</kbd>
    </form>
  );
}

function DownloadIndicator() {
  const { data } = useQuery({
    queryKey: ['downloads-mini'],
    queryFn: () => get<DownloadsSnapshot>('/downloads?limit=1', true),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
  if (!data) return null;
  return (
    <NavLink to="/downloads" className="hidden sm:flex items-center gap-1.5 text-xs text-muted hover:text-fg rounded-lg px-2 py-1.5 border border-line bg-surface whitespace-nowrap" title={data.pauseReason ?? 'Download speed'}>
      {data.sabPaused ? <Pause className="size-3.5 text-warn" /> : <Download className="size-3.5 text-info" />}
      <span className="tabular-nums">{data.sabPaused ? (data.guard.paused ? 'Guard pause' : 'Paused') : rate(data.speedBps)}</span>
      <span className="text-muted/70">· {data.totalJobs.toLocaleString()}</span>
    </NavLink>
  );
}

function Layout() {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  return (
    <SelectionProvider>
    <div className="min-h-screen md:pl-56">
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-56 flex-col border-r border-line bg-surface px-3 py-4">
        <NavLink to="/" className="flex items-center gap-2 px-2 mb-6">
          <img src="/icon.svg" alt="" className="size-8" />
          <span className="text-lg font-bold tracking-tight">Saga</span>
        </NavLink>
        <nav className="flex flex-col gap-0.5" aria-label="Main">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${isActive ? 'bg-surface-3 text-fg font-medium' : 'text-muted hover:text-fg hover:bg-surface-2'}`}
            >
              <n.icon className="size-4" aria-hidden />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto text-[11px] text-muted px-2">Admin · keep on your LAN/VPN</div>
      </aside>
      <header className="sticky top-0 z-30 flex items-center gap-3 px-4 py-2.5 border-b border-line bg-bg/85 backdrop-blur">
        <NavLink to="/" className="md:hidden shrink-0" aria-label="Saga home">
          <img src="/icon.svg" alt="" className="size-7" />
        </NavLink>
        <SearchBox />
        <DownloadIndicator />
      </header>
      <main className="px-4 py-5 pb-24 md:pb-10 max-w-[1600px] mx-auto">
        <Suspense fallback={<Spinner />}>
          <Outlet />
        </Suspense>
      </main>
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-line bg-surface/95 backdrop-blur pb-safe" aria-label="Main">
        <div className="grid grid-cols-5">
          {NAV.filter((n) => MOBILE_NAV.includes(n.to)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? 'text-accent' : 'text-muted'}`}>
              <n.icon className="size-5" aria-hidden />
              {n.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
    </SelectionProvider>
  );
}

function Root() {
  return (
    <AuthGate>
      <Outlet />
    </AuthGate>
  );
}

function NotFound() {
  return (
    <div className="text-center py-20 text-muted">
      Nothing here. <NavLink to="/" className="text-accent">Back to Discover</NavLink>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        element: <Layout />,
        children: [
          { path: '/', element: <DiscoverPage /> },
          { path: '/rail/:type/:rail', element: <RailPage /> },
          { path: '/browse', element: <BrowsePage /> },
          { path: '/movie/:id', element: <TitlePage type="movie" /> },
          { path: '/tv/:id', element: <TitlePage type="tv" /> },
          { path: '/collection/:id', element: <CollectionPage /> },
          { path: '/person/:id', element: <PersonPage /> },
          { path: '/search', element: <SearchPage /> },
          { path: '/lists', element: <ListsPage /> },
          { path: '/lists/view', element: <ListViewPage /> },
          { path: '/downloads', element: <DownloadsPage /> },
          { path: '/dashboard', element: <DashboardPage /> },
          { path: '/stack', element: <StackPage /> },
          { path: '/calendar', element: <CalendarPage /> },
          { path: '/providers', element: <ProvidersPage /> },
          { path: '/insights/*', element: <InsightsPage /> },
          { path: '/requests', element: <RequestsPage /> },
          { path: '/guests', element: <GuestsPage /> },
          { path: '/activity', element: <ActivityPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '/home', element: <Navigate to="/" replace /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);
