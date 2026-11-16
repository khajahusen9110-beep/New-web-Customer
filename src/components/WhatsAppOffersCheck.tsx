/** The ticked-by-default "Get offers and order updates on WhatsApp" box (checkout and My Account). */
export function WhatsAppOffersCheck({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="offers-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong className="block">Get offers &amp; order updates on WhatsApp</strong>
        <span className="muted small block">WhatsApp ನಲ್ಲಿ offers ಪಡೆಯಿರಿ · ಯಾವಾಗ ಬೇಕಾದರೂ untick ಮಾಡಬಹುದು</span>
      </span>
    </label>
  );
}
