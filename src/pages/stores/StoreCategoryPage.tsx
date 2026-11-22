import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Store as StoreIcon } from 'lucide-react';
import { useSession } from '../../store/session';
import { EmptyState, ErrorCard, ListSkeleton, PageHeader } from '../../components/ui';
import { getCustomerLocation, getStoresConfig, listStores, type StoreListItem, type StoresConfig } from '../../lib/stores';
import { StoreCard } from './parts';

/** The shops of one category: open ones first, the nearest on top (marked "Nearest"). */
export default function StoreCategoryPage() {
  const { categoryId = '' } = useParams();
  const navigate = useNavigate();
  const city = useSession((s) => s.selectedCity);
  const userId = useSession((s) => s.userId);
  const cityId = city?.id ?? null;
  const [cfg, setCfg] = useState<StoresConfig | null>(null);
  const [stores, setStores] = useState<StoreListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!cityId) return;
    setError(null);
    try {
      const [c, loc] = await Promise.all([getStoresConfig(cityId), getCustomerLocation(userId)]);
      setCfg(c);
      if (!c.stores_enabled) { navigate('/', { replace: true }); return; }
      setStores(await listStores(cityId, loc, categoryId));
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cityId, userId, categoryId]);

  const cat = cfg?.categories.find((c) => c.id === categoryId);
  return (
    <div className="page stores-page">
      <PageHeader title={cat?.name ?? 'Shops'} subtitle={cat?.name_kn ?? undefined} />
      <div className="content-pad narrow stack">
        {error && <ErrorCard message={error} onRetry={() => void load()} />}
        {stores === null && !error && <ListSkeleton count={3} height={88} />}
        {stores && stores.length === 0 && (
          <EmptyState icon={<StoreIcon size={36} />} title="No shops here yet" text={`We show shops within ${cfg?.radius_km ?? 5} km of you.`} />
        )}
        {stores?.map((s) => <StoreCard key={s.store_id} s={s} />)}
      </div>
    </div>
  );
}
