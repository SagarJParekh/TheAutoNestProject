import { useStore } from '../state/store';
import { cancelTool } from '../state/actions';
import { InfoPanel } from './panels/InfoPanel';
import { TransformPanel } from './panels/TransformPanel';
import { ClipCutPanel } from './panels/ClipCutPanel';
import { RepairPanel } from './panels/RepairPanel';
import { HollowPanel } from './panels/HollowPanel';
import { PerforatePanel } from './panels/PerforatePanel';
import { ExtrudePanel } from './panels/ExtrudePanel';
import { PreviewBar } from './panels/PreviewBar';
import { MeasurePanel } from './panels/MeasurePanel';
import { LabelPanel } from './panels/LabelPanel';
import { TexturePanel } from './panels/TexturePanel';
import { AlignTab, BooleanPanel, PropsTab } from './panels/RepairTabs';
import { LatticePanel, ShapesPanel, WrapPanel } from './panels/MakePanels';
import { DimensionsPanel } from './panels/DimensionsPanel';
import { ReportPanel } from './panels/ReportPanel';
import { OffsetPanel } from './panels/OffsetPanel';

const TITLES = {
  transform: 'Transform',
  clip: 'Clip & Cut',
  cut: 'Clip & Cut',
  repair: 'Repair',
  hollow: 'Hollow',
  perforate: 'Perforate',
  extrude: 'Extrude',
  measure: 'Measure',
  label: 'Label',
  texture: 'Texture',
  align: 'Align',
  props: 'Props',
  dimensions: 'Dimensions',
  report: 'Report',
  offset: 'Offset & fillet',
  build: 'Build',
  boolean: 'Boolean operations',
  lattice: 'Lattice',
  shapes: 'Shapes',
  wrap: 'Shrinkwrap',
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
        {(tool === 'clip' || tool === 'cut') && <ClipCutPanel parts={parts} />}
        {tool === 'repair' && <RepairPanel parts={parts} />}
        {tool === 'hollow' && <HollowPanel parts={parts} />}
        {tool === 'perforate' && <PerforatePanel />}
        {tool === 'extrude' && <ExtrudePanel />}
        {tool === 'measure' && <MeasurePanel />}
        {tool === 'label' && <LabelPanel />}
        {tool === 'texture' && <TexturePanel />}
        {tool === 'align' && <AlignTab />}
        {tool === 'props' && <PropsTab />}
        {tool === 'dimensions' && <DimensionsPanel parts={parts} />}
        {tool === 'report' && <ReportPanel />}
        {tool === 'offset' && <OffsetPanel parts={parts} />}
        {tool === 'boolean' && <BooleanPanel parts={parts} />}
        {tool === 'lattice' && <LatticePanel parts={parts} />}
        {tool === 'shapes' && <ShapesPanel />}
        {tool === 'wrap' && <WrapPanel parts={parts} />}
        {parts.length > 0 && tool !== 'dimensions' && tool !== 'report' && tool !== 'shapes' && <InfoPanel parts={parts} />}
      </div>
    </aside>
  );
}
