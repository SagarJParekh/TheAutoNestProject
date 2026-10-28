import { useState } from 'react';
import { Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { setTool } from '../../state/actions';
import { ClipPanel } from './ClipPanel';
import { CutPanel } from './CutPanel';
import { PlaneControls } from './PlaneControls';
import type { Part } from '../../state/types';

/** Clip (section view) and Cut (split the part) in one tool. */
export function ClipCutPanel({ parts }: { parts: Part[] }) {
  const tool = useStore((s) => s.tool);
  const clipEnabled = useStore((s) => s.clipEnabled);
  const cutMode = useStore((s) => s.settings.cutMode);
  return (
    <>
      <div className="repair-tabs">
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
              Cut the part at this plane…
            </button>
          </div>
        </>
      ) : (
        <>
          <CutPanel parts={parts} />
          {clipEnabled && cutMode === 'plane' && (
            <div className="section-body">
              <button className="btn wide" onClick={() => setState({ cutPlane: { ...getState().clip }, preview: null })} title="Put the cut plane where the section clip is">
                Use the clip plane
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
 * While the section clip is on, a small card in the viewport keeps it
 * adjustable from every other tool (plane, position, flip, off).
 */
export function ClipWidget() {
  const enabled = useStore((s) => s.clipEnabled);
  const tool = useStore((s) => s.tool);
  const workspace = useStore((s) => s.workspace);
  const clip = useStore((s) => s.clip);
  const all = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const [open, setOpen] = useState(true);
  if (!enabled || tool === 'clip' || workspace !== 'prep') return null;
  const parts = selection.length ? all.filter((p) => selection.includes(p.id)) : all;
  return (
    <div className="clip-widget">
      <header>
        <button className="mini" onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'}
        </button>
        <strong>Section clip</strong>
        <div className="grow" />
        <button className="mini" onClick={() => setTool('clip')} title="Open the Clip & Cut tool">
          Edit
        </button>
        <button className="mini" onClick={() => setState({ clipEnabled: false })} title="Turn the section clip off">
          Off
        </button>
      </header>
      {open && (
        <div className="clip-widget-body">
          <PlaneControls value={clip} parts={parts} multi combine onChange={(c) => setState({ clip: c })} />
        </div>
      )}
    </div>
  );
}
