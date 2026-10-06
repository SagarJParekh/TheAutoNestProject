import { useRef } from 'react';
import { Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { clearPointPick, loadCustomFont, previewLabel, startPointPick, worldPoint } from '../../state/featureActions';

export function LabelPanel() {
  const st = useStore((s) => s.settings.label);
  const pick = useStore((s) => s.pointPicks.label);
  useStore((s) => s.parts);
  const armed = useStore((s) => s.pickMode === 'point' && s.pointSlot === 'label');
  const custom = useStore((s) => s.customFont);
  const preview = useStore((s) => s.preview);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<typeof st>) => setState({ settings: { ...getState().settings, label: { ...getState().settings.label, ...patch } }, preview: null });
  const w = worldPoint(pick);
  return (
    <Section title="Label">
      <label className="textarea-field">
        <span className="row-label">Text</span>
        <textarea rows={2} value={st.text} onChange={(e) => set({ text: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      <Row label="Font">
        <select
          className="tb-select"
          value={st.font}
          onChange={(e) => (e.target.value === '__load' ? fileRef.current?.click() : set({ font: e.target.value }))}
        >
          <option value="sans-bold">Sans Bold</option>
          <option value="sans">Sans</option>
          <option value="serif">Serif Bold</option>
          <option value="mono">Mono Bold</option>
          {custom && <option value="custom">{custom.name}</option>}
          <option value="__load">Load .ttf / .otf…</option>
        </select>
        <input
          ref={fileRef}
          type="file"
          accept=".ttf,.otf,.woff"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) loadCustomFont(f);
          }}
        />
      </Row>
      <Row label="Shape">
        <Segmented
          value={st.conform ? 'curved' : 'flat'}
          onChange={(v) => set({ conform: v === 'curved' })}
          options={[
            { value: 'curved', label: 'Follow surface' },
            { value: 'flat', label: 'Flat plane' },
          ]}
        />
      </Row>
      <Row label="Mode">
        <Segmented
          value={st.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'emboss', label: 'Emboss (raised)' },
            { value: 'engrave', label: 'Engrave (cut in)' },
          ]}
        />
      </Row>
      <Row label="Size">
        <NumberField value={st.size} min={0.5} step={1} suffix="mm" onChange={(size) => set({ size })} />
      </Row>
      <Row label={st.mode === 'emboss' ? 'Height' : 'Depth'}>
        <NumberField value={st.depth} min={0.05} step={0.2} suffix="mm" onChange={(depth) => set({ depth })} />
      </Row>
      <Row label="Rotation">
        <NumberField value={st.rotation} step={15} suffix="°" onChange={(rotation) => set({ rotation })} />
      </Row>
      <Row label="Letter spacing">
        <NumberField value={st.letterSpacing ?? 0} step={0.02} precision={3} suffix="em" onChange={(letterSpacing) => set({ letterSpacing })} />
      </Row>
      {st.mode === 'emboss' && (
        <Row label="Sink">
          <NumberField value={st.sink} min={0} step={0.2} suffix="mm" title="How far letters reach into the surface; increase on curved faces" onChange={(sink) => set({ sink })} />
        </Row>
      )}
      <div className="pick-row">
        <button className={`btn ${armed ? 'primary' : ''}`} onClick={() => startPointPick('label')}>
          {armed ? 'Click on the part…' : pick ? 'Move label…' : 'Place label…'}
        </button>
        <span className="muted small">{w ? `on ${w.part.name}` : pick ? 'part changed — place again' : 'not placed'}</span>
        {pick && (
          <button className="mini" onClick={() => clearPointPick('label')}>
            Clear
          </button>
        )}
      </div>
      <button className="btn primary wide" disabled={!w || !!preview} onClick={previewLabel}>
        Preview label
      </button>
      <Hint>
        The text is centred on the picked point, upright relative to Z (or Y on top/bottom faces), and combined with the part by a boolean. “Follow surface”
        wraps the letters over curved faces (cylinders, domes…) keeping their size; “Flat plane” puts them on the tangent plane.
      </Hint>
    </Section>
  );
}
