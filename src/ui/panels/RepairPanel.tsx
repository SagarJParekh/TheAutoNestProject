import { useEffect } from 'react';
import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { AlignTab, CombineTab, FixExtras, PropsTab } from './RepairTabs';
import { getState, setState, useStore } from '../../state/store';
import { analyzePart, previewFillHoles, previewRepair } from '../../state/actions';
import type { Part, RepairTab, ToolSettings } from '../../state/types';

export function RepairPanel({ parts }: { parts: Part[] }) {
  const tab = useStore((s) => s.repairTab);
  return (
    <>
      <div className="repair-tabs">
        <Segmented<RepairTab>
          value={tab}
          onChange={(repairTab) => setState({ repairTab, pickMode: null, preview: null })}
          options={[
            { value: 'fix', label: 'Fix' },
            { value: 'combine', label: 'Combine' },
            { value: 'align', label: 'Align' },
            { value: 'props', label: 'Props' },
          ]}
        />
      </div>
      {tab === 'fix' && <FixTab parts={parts} />}
      {tab === 'combine' && <CombineTab parts={parts} />}
      {tab === 'align' && <AlignTab />}
      {tab === 'props' && <PropsTab />}
    </>
  );
}

function FixTab({ parts }: { parts: Part[] }) {
  const part = parts.length === 1 ? parts[0] : null;
  const entry = useStore((s) => (part ? s.analysis[part.id] : undefined));
  const settings = useStore((s) => s.settings);
  const preview = useStore((s) => s.preview);
  const report = entry && part && entry.mesh === part.mesh ? entry.report : null;
  const ix = useStore((s) => (part ? s.intersections[part.id] : undefined));
  const crossing = ix && part && ix.mesh === part.mesh ? ix.report.intersecting.length + ix.report.overlapping.length : 0;

  useEffect(() => {
    // analyse automatically for reasonably sized parts
    if (part && !report && part.mesh.indices.length / 3 < 3_000_000) analyzePart(part.id);
  }, [part, report]);

  const setRepair = (patch: Partial<ToolSettings['repair']>) =>
    setState({ settings: { ...getState().settings, repair: { ...getState().settings.repair, ...patch } } });
  const setHl = (patch: Partial<ToolSettings['highlight']>) =>
    setState({ settings: { ...getState().settings, highlight: { ...getState().settings.highlight, ...patch } } });

  if (!part) return <Section title="Repair"><Hint>Select one part to analyse and repair.</Hint></Section>;

  const rowItem = (label: string, value: number, color?: string, bad = value > 0) => (
    <>
      <dt>
        {color && <i className="dot" style={{ background: color }} />}
        {label}
      </dt>
      <dd className={bad ? 'warn' : 'okc'}>{value.toLocaleString()}</dd>
    </>
  );

  return (
    <>
      <Section
        title="Analysis"
        actions={
          <button className="mini" onClick={() => analyzePart(part.id)}>
            {report ? 'Re-run' : 'Analyse'}
          </button>
        }
      >
        {!report && <Hint>Run the analysis to find problems.</Hint>}
        {report && (
          <>
            <div className={`verdict ${report.watertight && !crossing ? 'ok' : 'bad'}`}>
              {!report.watertight
                ? 'Not watertight'
                : crossing
                  ? 'Watertight, but triangles intersect (see below)'
                  : 'Watertight — ready to print'}
            </div>
            <dl className="info">
              {rowItem('Open edges', report.openEdges, '#ff3b4e')}
              {rowItem('Holes', report.holes)}
              {rowItem('Non-manifold edges', report.nonManifoldEdges, '#ffb020')}
              {rowItem('Flipped triangles', report.flippedTriangles, '#d040ff')}
              {rowItem('Degenerate triangles', report.degenerateTriangles, '#00e0ff')}
              {rowItem('Duplicate triangles', report.duplicateTriangles)}
              {rowItem('Shells', report.shells, undefined, report.shells > 1)}
            </dl>
            <Row label="Highlight">
              <Check checked={settings.highlight.open} onChange={(open) => setHl({ open })}>Open</Check>
              <Check checked={settings.highlight.nonManifold} onChange={(nonManifold) => setHl({ nonManifold })}>Non-manifold</Check>
              <Check checked={settings.highlight.flipped} onChange={(flipped) => setHl({ flipped })}>Flipped</Check>
            </Row>
          </>
        )}
      </Section>

      {report && report.loops.length > 0 && (
        <Section
          title={`Holes (${report.loops.length})`}
          actions={
            <button className="mini" disabled={!!preview || part.locked} onClick={() => previewFillHoles()}>
              Fill all
            </button>
          }
        >
          <ul className="hole-list" onMouseLeave={() => setHl({ holeIndex: null })}>
            {report.loops.slice(0, 300).map((l, i) => (
              <li key={i} onMouseEnter={() => setHl({ holeIndex: i })} className={settings.highlight.holeIndex === i ? 'hover' : ''}>
                <span>
                  #{i + 1} · {l.vertices.length} edges · {l.perimeter.toFixed(2)} mm
                </span>
                <button className="mini" disabled={!!preview || part.locked} onClick={() => previewFillHoles([i])}>
                  Fill
                </button>
              </li>
            ))}
          </ul>
          {report.loops.length > 300 && <Hint>Showing the first 300 holes.</Hint>}
        </Section>
      )}

      <Section title="Auto repair">
        <Check checked={settings.repair.stitch} onChange={(stitch) => setRepair({ stitch })}>
          Stitch cracks
        </Check>
        <Check checked={settings.repair.fillHoles} onChange={(fillHoles) => setRepair({ fillHoles })}>
          Fill holes
        </Check>
        <Check checked={settings.repair.removeSmallShells} onChange={(removeSmallShells) => setRepair({ removeSmallShells })}>
          Remove small floating shells
        </Check>
        {settings.repair.removeSmallShells && (
          <Row label="Smaller than">
            <NumberField
              value={settings.repair.smallShellRatio * 100}
              min={0}
              max={100}
              suffix="% vol"
              onChange={(v) => setRepair({ smallShellRatio: v / 100 })}
            />
          </Row>
        )}
        <Row label="Weld distance">
          <NumberField
            value={settings.repair.weldTolerance}
            min={0}
            step={0.001}
            precision={4}
            suffix="mm"
            title="0 = automatic"
            onChange={(weldTolerance) => setRepair({ weldTolerance })}
          />
        </Row>
        <button className="btn primary wide" disabled={!!preview || part.locked} onClick={previewRepair}>
          Auto repair…
        </button>
        <Hint>Welds duplicate vertices, removes degenerate/duplicate triangles, stitches cracks, fixes winding, fills holes. Shows a before/after summary before applying.</Hint>
      </Section>
      <FixExtras part={part} />
    </>
  );
}
