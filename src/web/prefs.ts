import { useEffect, useState } from 'react';

/** Per-browser preferences in localStorage, shared live between components. */
const EVENT = 'saga:prefs';

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback));
  useEffect(() => {
    const sync = () => setValue(read(key, fallback));
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [key]);
  const set = (v: T) => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* private mode: keep it in memory only */
    }
    setValue(v);
    window.dispatchEvent(new Event(EVENT));
  };
  return [value, set];
}

/** Discover/Browse: leave out titles already in Radarr/Sonarr (on by default). */
export const useHideOwned = () => usePref('saga.hideOwned', true);
