import { Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { markedTriangles, previewRemeshRegion, regionEdgeLength } from '../../state/editActions';
import { live } from '../../state/livePreview';
import { FacePickSection } from './FacePickSection';
import type { Part } from '../../state/types';

type Settings = ReturnType<typeof getState>['settings']['remesh'];
const set = (patch: Partial<Settings>) => setState({ settings: { ...getState().settings, remesh: { ...getState().settings.remesh, ...patch } } });

/** What the Remesh tool works on now: the part and its triangles to remesh (null region: the whole part). */
function target(parts: Part[]): { part: Part; region: Uint32Array | null; what: string } | null {
  const s = getState();
  const src = s.settings.remesh.source;
  if (src === 'faces') {
    const fs = s.faceSelection;
    const part = fs && s.parts.find((p) => p.id === fs.partId);
    if (!fs || !part || (fs.mesh && fs.mesh !== part.mesh)) return null;
    const n = fs.groups?.length ?? 1;
    return { part, region: fs.tris, what: `${n > 1 ? `${n} surfaces` : 'surface'} (${fs.tris.length.toLocaleString()} triangles)` };
  }
  if (src === 'marked') {
    const m = markedTriangles();
    return m ? { part: m.part, region: Uint32Array.from(m.tris), what: `${m.tris.length.toLocaleString()} marked triangles` } : null;
  }
  const part = parts.find((p) => !p.locked);
  return part ? { part, region: null, what: part.name } : null;
}

/** Run the remesh preview on the current target. */
export function previewSurfaceRemesh() {
  const s = getState();
  const t = target(s.parts.filter((p) => s.selection.includes(p.id)));
  if (!t) return;
  return previewRemeshRegion(t.part, t.region, t.region ? `Remesh ${t.what}` : `Remesh ${t.part.name}`);
}

/**
 * Remesh tool: an even (isotropic) remesh of only the picked surfaces, only
 * the marked triangles, or the whole part. Triangles outside the surface are
 * not touched and the surface's border stays attached to them.
 */
export function RemeshPanel({ parts }: { parts: Part[] }) {
  const st = useStore((s) => s.settings.remesh);
  const preview = useStore((s) => s.preview);
  useStore((s) => s.faceSelection);
  useStore((s) => s.triEdit);
  const markBar = useStore((s) => s.markBar);
  const t = target(parts);
  return (
    <>
      <Section title="1. Surface to remesh">
        <Segmented
          value={st.source}
          onChange={(source) => {
            set({ source });
            // the marked triangles come from the Mark widget: open it
            if (source === 'marked') setState({ markBar: true });
          }}
          options={[
            { value: 'faces', label: 'Picked surfaces', title: 'Click the surfaces to remesh (each grows up to sharp edges)' },
            { value: 'marked', label: 'Marked triangles', title: 'The triangles marked with the Mark tools (Mark widget in the view, or Repair → Edit)' },
            { value: 'part', label: 'Whole part', title: 'Every triangle of the selected part' },
          ]}
        />
        {st.source === 'faces' && <FacePickSection tool="remesh" />}
        {st.source === 'marked' && (
          <>
            <p className="muted small">{t ? `${t.what} on ${t.part.name}` : 'Nothing marked yet.'}</p>
            {!markBar && (
              <button className="btn wide" onClick={() => setState({ markBar: true })}>
                Open the Mark tools
              </button>
            )}
            <Hint>Mark the triangles with the Mark tools in the view (triangle, plane, surface, shell, brush or window), then preview.</Hint>
          </>
        )}
        {st.source === 'part' && !t && <Hint>Select an unlocked part.</Hint>}
      </Section>
      <Section title="2. Remesh">
        <Row label="Edge length">
          <NumberField value={st.edgeLength} min={0.01} step={0.1} suffix="mm" title="Target length of the new triangle edges" onChange={(edgeLength) => set({ edgeLength: Math.max(0.01, edgeLength) })} />
          <button
            className="mini"
            disabled={!t}
            onClick={() => t && set({ edgeLength: Math.round(regionEdgeLength(t.part, t.region) * 1000) / 1000 })}
            title="Use the surface's current average edge length"
          >
            Average
          </button>
        </Row>
        <Row label="Keep sharp edges over">
          <NumberField value={st.featureAngle} min={1} max={180} suffix="°" title="Edges sharper than this stay where they are" onChange={(featureAngle) => set({ featureAngle })} />
        </Row>
        <Row label="Passes">
          <NumberField value={st.iterations} min={1} max={20} step={1} precision={0} title="More passes: more even triangles, slower" onChange={(iterations) => set({ iterations: Math.round(iterations) })} />
        </Row>
        <button className="btn primary wide" disabled={!t || !!preview || t.part.locked} onClick={() => live(previewSurfaceRemesh)}>
          {t ? `Preview remesh: ${t.what}` : 'Preview remesh'}
        </button>
        <Hint>
          Makes the triangles of the chosen surface even, about the edge length in size (smaller: finer, more triangles). Only that surface changes: the rest
          of the part keeps its triangles and the border of the surface stays joined to it, so a closed part stays closed.
        </Hint>
      </Section>
    </>
  );
}
