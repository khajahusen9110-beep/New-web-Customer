import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Star } from 'lucide-react';
import { getPendingReview, getStoreRatingSummary, MIN_REVIEWS_FOR_STARS, type PendingReview, type StoreRatingSummary } from '../../lib/stores';
import { useSession } from '../../store/session';

/** Average, bars per star and the latest written reviews. Nothing is shown for a shop nobody rated yet. */
export function StoreRatingSection({ storeId }: { storeId: string }) {
  const [s, setS] = useState<StoreRatingSummary | null>(null);
  useEffect(() => { let on = true; void getStoreRatingSummary(storeId).then((r) => on && setS(r)); return () => { on = false; }; }, [storeId]);
  if (!s || s.review_count === 0) return null;
  const most = Math.max(1, ...Object.values(s.distribution));
  return (
    <section className="rating-card" data-testid="store-rating-section">
      <h3>Ratings &amp; reviews</h3>
      <div className="rating-top">
        <div className="rating-big">
          {s.review_count >= MIN_REVIEWS_FOR_STARS && s.avg_rating != null
            ? <strong><Star size={22} fill="currentColor" /> {s.avg_rating.toFixed(1)}</strong>
            : <strong className="rating-new">✨ New</strong>}
          <span className="muted small">{s.review_count} rating{s.review_count > 1 ? 's' : ''}</span>
        </div>
        <div className="rating-bars">
          {[5, 4, 3, 2, 1].map((n) => (
            <div key={n} className="rating-bar"><span>{n}</span><i><b style={{ width: `${((s.distribution[String(n)] ?? 0) / most) * 100}%` }} /></i><em>{s.distribution[String(n)] ?? 0}</em></div>
          ))}
        </div>
      </div>
      {s.recent.map((c, i) => (
        <div key={i} className="rating-review">
          <div><strong>{c.name}</strong><span><Star size={13} fill="currentColor" /> {c.rating}</span></div>
          <p>{c.comment}</p>
        </div>
      ))}
    </section>
  );
}

/** "How was your order?" nudge on the home screen; opens that order, where the rating form already is. */
export function ReviewPromptCard() {
  const navigate = useNavigate();
  const loggedIn = useSession((s) => s.isLoggedIn);
  const [p, setP] = useState<PendingReview | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => { if (loggedIn) void getPendingReview().then(setP); }, [loggedIn]);
  if (!p || hidden) return null;
  return (
    <div className="review-prompt" role="link" tabIndex={0} data-testid="review-prompt" onClick={() => navigate(`/orders/${p.order_id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/orders/${p.order_id}`)}>
      <div><strong>How was {p.vendor_name}?</strong><span>★★★★★ Tap to rate your order</span></div>
      <ChevronRight size={20} />
      <button className="link-btn" onClick={(e) => { e.stopPropagation(); setHidden(true); }}>Later</button>
    </div>
  );
}
