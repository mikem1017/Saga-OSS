import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Loading } from '../components.tsx';

/** Web Share Target: a link shared from the phone's share sheet (IMDb, Letterboxd, TMDB…) becomes a search. */
export default function SharePage() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  useEffect(() => {
    const blob = [sp.get('url'), sp.get('text'), sp.get('title')].filter(Boolean).join(' ');
    // Apps often put the link in `text`; prefer the first URL anywhere in what was shared.
    const link = blob.match(/https?:\/\/\S+/)?.[0];
    const q = link ?? sp.get('title') ?? sp.get('text') ?? '';
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/', { replace: true });
  }, [sp, navigate]);
  return <Loading />;
}
