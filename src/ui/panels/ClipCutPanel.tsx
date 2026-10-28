import { useState } from 'react';
import { Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { setTool } from '../../state/actions';
import { ClipPanel, resetClip } from './ClipPanel';
import { CutPanel } from './CutPanel';
import { AxisCuts } from './PlaneControls';
import { Icon } from '../icons';
import type { Part } from '../../state/types';

/** Clip (section view) and Cut (split the part) in one tool. */
export function ClipCutPanel({ parts }: { parts: Part[] }) {
  const tool = useStore((s) => s.tool);
  const clipEnabled = useStore((s) => s.clipEnabled);
  const cutMode = useStore((s) => s.settings.cutMode);
  return (
    <>
      <div className="repair-tabs two-tabs">
        <Segmented
          value={tool === 'cut' ? 'cut' : 'clip'}
          onChange={(t) => setTool(t)}
          options={[
            { value: 'clip', label: 'Clip (section view)' },
            { value: 'cut', label: 'Cut part' },
          ]}
        />
      </div>
      {tool === 'clip' ? (
        <>
          <ClipPanel />
          <div className="section-body">
            <button className="btn wide" disabled={!clipEnabled} onClick={cutAtClip} title="Switch to Cut with the plane where the section is now">
              Cut the parts at these planes…
            </button>
          </div>
        </>
      ) : (
        <>
          <CutPanel parts={parts} />
          {clipEnabled && cutMode === 'plane' && (
            <div className="section-body">
              <button className="btn wide" onClick={() => setState({ cutPlane: { ...getState().clip }, preview: null })} title="Put the cut planes where the section clip planes are">
                Use the clip planes
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function cutAtClip() {
  // switching tool re-centres the cut plane, so copy the clip plane afterwards
  setTool('cut');
  const s = getState();
  setState({ cutPlane: { ...s.clip }, settings: { ...s.settings, cutMode: 'plane' } });
}

/**
 * The section clip from every other tool: a small button in the viewport turns
 * it on, then a card holds the X / Y / Z rows, so parts and previews (hollow,
 * lattice…) can be clipped and checked before Apply.
 */
export function ClipWidget() {
  const enabled = useStore((s) => s.clipEnabled);
  const tool = useStore((s) => s.tool);
  const workspace = useStore((s) => s.workspace);
  const clip = useStore((s) => s.clip);
  const all = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const hasPreview = useStore((s) => !!s.preview);
  const [open, setOpen] = useState(true);
  if (tool === 'clip' || workspace !== 'prep' || !all.length) return null;
  const parts = selection.length ? all.filter((p) => selection.includes(p.id)) : all;
  if (!enabled)
    return (
      <button
        className="clip-chip"
        onClick={() => {
          // start through the middle of what is selected (or of everything)
          resetClip(parts);
          setState({ clipEnabled: true });
          setOpen(true);
        }}
        title={hasPreview ? 'Clip the preview to look inside before applying' : 'Section clip: look inside the parts'}
      >
        {Icon.cut} Section clip
      </button>
    );
  return (
    <div className="clip-widget">
      <header>
        <button className="mini" onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'}
        </button>
        <strong>Section clip</strong>
        <div className="grow" />
        <button className="mini" onClick={() => resetClip(parts)} title="Planes back through the middle of the parts">
          Reset
        </button>
        <button className="mini" onClick={() => setState({ clipEnabled: false })} title="Turn the section clip off">
          Off
        </button>
      </header>
      {open && (
        <div className="clip-widget-body">
          <AxisCuts kind="clip" value={clip} parts={parts} onChange={(c) => setState({ clip: c })} />
        </div>
      )}
    </div>
  );
}
