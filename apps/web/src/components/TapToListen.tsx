/**
 * Autoplay-gesture gate. Mobile WebViews (and most desktop browsers) block audio until
 * a user gesture, so the actual audio.play() is kicked off from this button's onClick
 * inside RadioPlayer — passing the handler through here preserves the gesture.
 */
export function TapToListen({ onTap, disabled }: { onTap: () => void; disabled?: boolean }) {
  return (
    <button className="tap-to-listen" onClick={onTap} disabled={disabled}>
      Tap to Listen
    </button>
  );
}
