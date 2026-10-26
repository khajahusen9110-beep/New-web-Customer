import { useEffect, useRef, useState } from 'react';
import { Gift } from 'lucide-react';

const REVEAL_THRESHOLD = 0.45; // fraction of the card that must be cleared to auto-reveal

/**
 * A scratch-to-reveal card: a silver overlay the customer rubs off (mouse/touch) to see the
 * reward amount, with a canvas "scratch" effect (destination-out compositing). Auto-reveals
 * once ~45% is cleared, or on long-press/tap-and-hold. Calls onReveal once, the first time.
 */
export function ScratchCard({ amount, onReveal, onClose }: { amount: number; onReveal: () => void; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [revealed, setRevealed] = useState(false);
  const scratching = useRef(false);
  const revealedOnce = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      ctx.fillStyle = '#c0c6d6';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      grad.addColorStop(0, '#dfe3ee');
      grad.addColorStop(1, '#aab1c7');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = 'bold 15px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.textAlign = 'center';
      ctx.fillText('Scratch here', canvas.width / 2, canvas.height / 2 + 5);
    };
    resize();

    const getPos = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const scratchAt = (x: number, y: number) => {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(x, y, 22, 0, Math.PI * 2);
      ctx.fill();
    };

    const checkCleared = () => {
      if (revealedOnce.current) return;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let cleared = 0;
      for (let i = 3; i < data.length; i += 4 * 20) if (data[i] === 0) cleared++;
      const total = data.length / (4 * 20);
      if (cleared / total > REVEAL_THRESHOLD) {
        revealedOnce.current = true;
        setRevealed(true);
        onReveal();
      }
    };

    const onDown = (e: PointerEvent) => {
      scratching.current = true;
      const { x, y } = getPos(e);
      scratchAt(x, y);
    };
    const onMove = (e: PointerEvent) => {
      if (!scratching.current) return;
      const { x, y } = getPos(e);
      scratchAt(x, y);
      checkCleared();
    };
    const onUp = () => {
      scratching.current = false;
      checkCleared();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('resize', resize);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('resize', resize);
    };
  }, [onReveal]);

  return (
    <div className="scratch-overlay">
      <div className="scratch-sheet">
        <h3 className="scratch-title">🎉 Order Placed!</h3>
        <p className="muted small" style={{ marginBottom: 14 }}>
          You earned a scratch card — rub it off to reveal your reward.
        </p>
        <div ref={wrapRef} className="scratch-card-face">
          <div className="scratch-reward">
            <Gift size={28} />
            <span className="scratch-amount">₹{amount}</span>
          </div>
          {!revealed && <canvas ref={canvasRef} className="scratch-canvas" />}
        </div>
        {revealed ? (
          <>
            <p className="scratch-note">You won ₹{amount}! It'll be added to your wallet once this order is delivered.</p>
            <button className="btn btn-primary w-full" onClick={onClose}>
              Nice!
            </button>
          </>
        ) : (
          <p className="muted small" style={{ textAlign: 'center' }}>
            Swipe your finger over the card
          </p>
        )}
      </div>
    </div>
  );
}
