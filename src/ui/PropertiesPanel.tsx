import { useStore } from '../state/store';
import { cancelTool } from '../state/actions';
import { InfoPanel } from './panels/InfoPanel';
import { TransformPanel } from './panels/TransformPanel';
import { ClipPanel } from './panels/ClipPanel';
import { CutPanel } from './panels/CutPanel';
import { RepairPanel } from './panels/RepairPanel';
import { HollowPanel } from './panels/HollowPanel';
import { PerforatePanel } from './panels/PerforatePanel';
import { ExtrudePanel } from './panels/ExtrudePanel';
import { PreviewBar } from './panels/PreviewBar';
import { MeasurePanel } from './panels/MeasurePanel';
import { LabelPanel } from './panels/LabelPanel';
import { TexturePanel } from './panels/TexturePanel';

const TITLES = {
  transform: 'Transform',
  clip: 'Clip',
  cut: 'Cut',
  repair: 'Repair',
  hollow: 'Hollow',
  perforate: 'Perforate',
  extrude: 'Extrude',
  measure: 'Measure',
  label: 'Label',
  texture: 'Texture',
};

export function PropertiesPanel() {
  const tool = useStore((s) => s.tool);
  const allParts = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const sel = new Set(selection);
  const parts = allParts.filter((p) => sel.has(p.id));
  return (
    <aside className="panel right">
      <header className="panel-head">
        <h2>{TITLES[tool]}</h2>
        <div className="grow" />
        {tool !== 'transform' && (
          <button className="mini" onClick={cancelTool} title="Cancel this tool: discard its preview and picks and return to Transform">
            Cancel
          </button>
        )}
      </header>
      <div className="panel-scroll">
        <PreviewBar />
        {tool === 'transform' && <TransformPanel parts={parts} />}
        {tool === 'clip' && <ClipPanel />}
        {tool === 'cut' && <CutPanel parts={parts} />}
        {tool === 'repair' && <RepairPanel parts={parts} />}
        {tool === 'hollow' && <HollowPanel parts={parts} />}
        {tool === 'perforate' && <PerforatePanel />}
        {tool === 'extrude' && <ExtrudePanel />}
        {tool === 'measure' && <MeasurePanel />}
        {tool === 'label' && <LabelPanel />}
        {tool === 'texture' && <TexturePanel />}
        {parts.length > 0 && <InfoPanel parts={parts} />}
      </div>
    </aside>
  );
}
