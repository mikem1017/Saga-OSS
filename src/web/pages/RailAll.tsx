import { useParams, useSearchParams } from 'react-router';
import { PagedGrid } from '../components/Paged.tsx';
import { PageHeader, Toggle } from '../components/ui.tsx';
import { useHideOwned } from '../prefs.ts';

export default function RailPage() {
  const { type = 'movie', rail = 'trending' } = useParams();
  const [params] = useSearchParams();
  const [hide, setHide] = useHideOwned();
  return (
    <div>
      <PageHeader title={params.get('title') ?? rail} sub={type === 'tv' ? 'TV' : 'Movies'} actions={<Toggle checked={hide} onChange={setHide} label="Hide titles I have" />} />
      <PagedGrid path={`/discover/rail/${rail}?type=${type}${hide ? '&hide=1' : ''}`} queryKey={['rail-all', type, rail, hide]} />
    </div>
  );
}
