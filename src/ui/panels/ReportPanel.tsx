import { useState } from 'react';
import { Hint, Section, Segmented } from '../controls';
import { notify, useStore } from '../../state/store';
import { copyReport, REPORT_HEADER, reportCSV, reportRows } from '../../state/report';

const f2 = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function ReportPanel() {
  const parts = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [copied, setCopied] = useState(false);
  const chosen = scope === 'all' || !selection.length ? parts : parts.filter((p) => selection.includes(p.id));
  const rows = reportRows(chosen);
  const copy = async () => {
    if (!rows.length) return;
    const ok = await copyReport(rows);
    if (!ok) return notify('error', 'Could not copy to the clipboard');
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  const download = () => {
    const blob = new Blob([reportCSV(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'parts-report.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  return (
    <Section title={`Parts report (${rows.length})`}>
      <Segmented
        value={selection.length ? scope : 'all'}
        onChange={setScope}
        options={[
          { value: 'all', label: `All parts (${parts.length})` },
          { value: 'selected', label: `Selected (${selection.length})` },
        ]}
      />
      <div className="report-actions">
        <button className="btn primary" disabled={!rows.length} onClick={copy} title="Copy as a table; paste into Excel with Ctrl+V">
          {copied ? '✓ Copied' : 'Copy for Excel'}
        </button>
        <button className="btn" disabled={!rows.length} onClick={download}>
          Download CSV
        </button>
      </div>
      <div className="report-wrap">
        <table className="report">
          <thead>
            <tr>
              {REPORT_HEADER.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="name" title={r.name}>
                  {r.name}
                </td>
                <td />
                <td title={r.inverted ? 'The part is inside-out; the absolute volume is shown' : undefined}>
                  {f2(r.volume)}
                  {r.inverted ? ' ⚠' : ''}
                </td>
                <td>{f2(r.x)}</td>
                <td>{f2(r.y)}</td>
                <td>{f2(r.z)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <Hint>Open some parts to build the report.</Hint>}
      <Hint>
        Volume in mm³, X / Y / Z are the bounding-box sizes in mm (as placed, transforms included). Quantity is left blank to fill in. “Copy for Excel”
        copies the header and all rows; paste into the first cell. The volume is exact only for watertight parts.
      </Hint>
    </Section>
  );
}
