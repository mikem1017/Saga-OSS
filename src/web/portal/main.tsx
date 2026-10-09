import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { router } from './App.tsx';
import { ToastProvider } from '../components/toast.tsx';
import { ApiError, setErrorHandler } from './api.ts';
import '../styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider register={(push) => setErrorHandler((m) => push(m, 'error'))}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// After a deploy, a tab that was already open asks for code chunks the new build no longer has. Reload once to
// pick up the new version (guarded so a genuinely broken chunk can't cause a reload loop).
window.addEventListener('vite:preloadError', (event) => {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem('saga.chunkReloadAt') ?? 0);
    sessionStorage.setItem('saga.chunkReloadAt', String(Date.now()));
  } catch {
    /* storage blocked: still reload once */
  }
  if (Date.now() - last > 10_000) {
    event.preventDefault();
    window.location.reload();
  }
});
