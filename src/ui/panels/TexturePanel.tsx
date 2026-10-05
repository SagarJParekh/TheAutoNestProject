import { useRef } from 'react';
import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { loadHeightmap, previewTexture } from '../../state/featureActions';
import { clearPick, startPick } from '../../state/repairActions';
import type { TexturePattern } from '../../geometry';

export function TexturePanel() {
  const st = useStore((s) => s.settings.texture);
  const pick = useStore((s) => s.facePicks.texture);
  const part = useStore((s) => (pick ? s.parts.find((p) => p.id === pick.partId) : undefined));
  const armed = useStore((s) => s.pickMode === 'face' && s.pickSlot === 'texture');
  const hm = useStore((s) => s.heightmap);
  const preview = useStore((s) => s.preview);
  const selCount = useStore((s) => s.selection.length);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<typeof st>) => setState({ settings: { ...getState().settings, texture: { ...getState().settings.texture, ...patch } }, preview: null });
  const valid = st.scope === 'part' ? selCount > 0 : !!(pick && part && part.mesh === pick.mesh);
  return (
    <Section title="Texture">
      <Row label="Apply to">
        <Segmented
          value={st.scope}
          onChange={(scope) => set({ scope, projection: scope === 'part' ? 'triplanar' : 'planar' })}
          options={[
            { value: 'face', label: 'Picked face' },
            { value: 'part', label: 'Whole part' },
          ]}
        />
      </Row>
      {st.scope === 'face' && (
        <>
          <Check checked={st.smooth} onChange={(smooth) => set({ smooth, angleTolerance: smooth ? 25 : 2, projection: smooth ? 'cylindrical' : 'planar' })}>
            Grow across smooth curved surfaces
          </Check>
          <Row label={st.smooth ? 'Max crease' : 'Angle tolerance'}>
            <NumberField value={st.angleTolerance} min={0} max={89} step={1} suffix="°" onChange={(angleTolerance) => set({ angleTolerance })} />
          </Row>
          <div className="pick-row">
            <button className={`btn ${armed ? 'primary' : ''}`} onClick={() => startPick('texture')}>
              {armed ? 'Click a face…' : 'Pick face…'}
            </button>
            <span className="muted small">{pick && part ? `${part.name} · ${pick.tris.length} tris · ${pick.area.toFixed(0)} mm²` : 'not picked'}</span>
            {pick && (
              <button className="mini" onClick={() => clearPick('texture')}>
                Clear
              </button>
            )}
          </div>
        </>
      )}
      <Row label="Pattern">
        <select className="tb-select" value={st.pattern} onChange={(e) => set({ pattern: e.target.value as TexturePattern })}>
          <option value="knurl">Diamond knurl</option>
          <option value="ribs">Ribs</option>
          <option value="waffle">Waffle</option>
          <option value="dots">Dots</option>
          <option value="hex">Hex tiles</option>
          <option value="noise">Noise (stone)</option>
          <option value="image">Image heightmap</option>
        </select>
      </Row>
      {st.pattern === 'image' && (
        <Row label="Image">
          <button className="btn" onClick={() => fileRef.current?.click()}>
            {hm ? 'Change…' : 'Load PNG/JPG…'}
          </button>
          <span className="muted small">{hm ? `${hm.name} (${hm.map.width}×${hm.map.height})` : 'white = high'}</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) loadHeightmap(f);
            }}
          />
        </Row>
      )}
      {st.pattern === 'image' && (
        <Row label="Image placement">
          <Segmented
            value={st.imageFit ?? 'fit'}
            onChange={(imageFit) => set({ imageFit, projection: st.projection === 'triplanar' && imageFit === 'fit' ? 'planar' : st.projection })}
            options={[
              { value: 'fit', label: 'Fit to face', title: 'Stretch the image once over the area (aspect kept)' },
              { value: 'tile', label: 'Tile', title: 'Repeat the image every “tile width” mm' },
            ]}
          />
        </Row>
      )}
      {!(st.pattern === 'image' && (st.imageFit ?? 'fit') === 'fit') && (
        <Row label={st.pattern === 'image' ? 'Tile width' : 'Period'}>
          <NumberField value={st.period} min={0.2} step={0.5} suffix="mm" onChange={(period) => set({ period })} />
        </Row>
      )}
      <Row label="Depth">
        <NumberField value={st.depth} step={0.1} suffix="mm" title="Positive raises the pattern, negative carves it in" onChange={(depth) => set({ depth })} />
      </Row>
      <Row label="Rotation">
        <NumberField value={st.angle} step={15} suffix="°" onChange={(angle) => set({ angle })} />
      </Row>
      <Row label="Resolution">
        <NumberField value={st.resolution ?? 0} min={0} step={0.05} precision={3} suffix="mm" title="Target edge length; 0 = automatic (period / 6, or one vertex per image pixel)" onChange={(resolution) => set({ resolution })} />
      </Row>
      <Row label="Projection">
        <Segmented
          value={st.projection}
          onChange={(projection) => set({ projection })}
          options={[
            { value: 'planar', label: 'Planar' },
            { value: 'cylindrical', label: 'Cylindrical' },
            { value: 'triplanar', label: 'Triplanar' },
          ]}
        />
      </Row>
      <Check checked={!!st.invert} onChange={(invert) => set({ invert })}>
        Invert pattern
      </Check>
      <button className="btn primary wide" disabled={!valid || !!preview} onClick={previewTexture}>
        Preview texture
      </button>
      <Hint>The area is subdivided to the resolution and displaced along the surface normal; the edges of a picked face stay fixed so the part remains watertight. Fine textures on large areas create many triangles.</Hint>
    </Section>
  );
}
