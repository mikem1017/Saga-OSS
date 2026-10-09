import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';
import { createBrowserRouter, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Compass, Inbox, CalendarClock, Settings, Search } from 'lucide-react';
import type { GuestMe } from './types.ts';
import { get, setCsrf, setUnauthorizedHandler } from './api.ts';
import { Loading } from './components.tsx';
import { LoginPage, InvitePage, MagicPage } from './pages/Auth.tsx';
import HomePage from './pages/Home.tsx';

const TitlePage = lazy(() => import('./pages/Title.tsx'));
const SearchPage = lazy(() => import('./pages/Search.tsx'));
const RequestsPage = lazy(() => import('./pages/Requests.tsx'));
const SoonPage = lazy(() => import('./pages/Soon.tsx'));
const SettingsPage = lazy(() => import('./pages/Settings.tsx'));
const SharePage = lazy(() => import('./pages/Share.tsx'));

const MeCtx = createContext<{ me: GuestMe | null; refresh: () => void }>({ me: null, refresh: () => {} });
export const useMe = () => useContext(MeCtx);

const PUBLIC = ['/login', '/invite', '/auth/magic'];

function Gate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const isPublic = PUBLIC.some((p) => location.pathname.startsWith(p));
  const [failed, setFailed] = useState(false);
  const { data: me, refetch, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const m = await get<GuestMe>('/me', true);
        setCsrf(m.csrf);
        setFailed(false);
        return m;
      } catch {
        setFailed(true);
        return null;
      }
    },
    staleTime: 30_000,
  });
  useEffect(() => {
    setUnauthorizedHandler(() => setFailed(true));
  }, []);
  useEffect(() => {
    if (!isLoading && (failed || me === null) && !isPublic) navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
  }, [failed, me, isLoading, isPublic, location.pathname, location.search, navigate]);
  if (isLoading && !isPublic) return <Loading />;
  return <MeCtx.Provider value={{ me: me ?? null, refresh: () => void refetch() }}>{children}</MeCtx.Provider>;
}

const TABS = [
  { to: '/', label: 'Discover', icon: Compass, end: true },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/requests', label: 'My requests', icon: Inbox },
  { to: '/soon', label: 'Coming soon', icon: CalendarClock },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function Layout() {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  return (
    <div className="min-h-screen pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-8">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 py-2.5 flex items-center gap-4">
          <NavLink to="/" className="flex items-center gap-2 shrink-0">
            <img src="/icon.svg" alt="" className="size-7" />
            <span className="font-bold tracking-tight">Saga Requests</span>
          </NavLink>
          <nav className="hidden md:flex items-center gap-1 ml-auto" aria-label="Main">
            {TABS.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg'}`}>
                {t.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-5">
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-line bg-surface/95 backdrop-blur pb-safe" aria-label="Main">
        <div className="grid grid-cols-5">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-[10px] ${isActive ? 'text-accent' : 'text-muted'}`}>
              <t.icon className="size-5" aria-hidden />
              {t.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

function Root() {
  return (
    <Gate>
      <Outlet />
    </Gate>
  );
}

export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/invite/:code', element: <InvitePage /> },
      { path: '/auth/magic', element: <MagicPage /> },
      {
        element: <Layout />,
        children: [
          { path: '/', element: <HomePage /> },
          { path: '/search', element: <SearchPage /> },
          { path: '/movie/:id', element: <TitlePage type="movie" /> },
          { path: '/tv/:id', element: <TitlePage type="tv" /> },
          { path: '/requests', element: <RequestsPage /> },
          { path: '/soon', element: <SoonPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '/share', element: <SharePage /> },
          { path: '*', element: <HomePage /> },
        ],
      },
    ],
  },
]);
