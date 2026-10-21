import { Check, NumberField } from './controls';
import { setState, useStore } from '../state/store';

/** Snapping for the move / rotate gizmos and pick & place (shared by Mesh prep and Build generation). */
export function SnapControls() {
  const snap = useStore((s) => s.snap);
  const set = (patch: Partial<typeof snap>) => setState((s) => ({ snap: { ...s.snap, ...patch } }));
  return (
    <div className="snap-row">
      <Check checked={snap.on} onChange={(on) => set({ on })}>
        Snap
      </Check>
      <NumberField value={snap.move} min={0.01} step={0.5} suffix="mm" disabled={!snap.on} title="Move in steps of (positions land on multiples of this)" onChange={(move) => set({ move: Math.max(0.01, move) })} />
      <NumberField value={snap.rotate} min={0.1} step={5} suffix="°" disabled={!snap.on} title="Rotate in steps of" onChange={(rotate) => set({ rotate: Math.max(0.1, rotate) })} />
    </div>
  );
}
