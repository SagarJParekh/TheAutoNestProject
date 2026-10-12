/**
 * Live preview: once a preview has been started from a tool's "Preview"
 * button, changing that tool's settings (or its picks) re-runs it after a
 * short pause, so the preview follows the edits. Nothing is changed until
 * Apply; Cancel, Apply or switching tools ends the live session.
 */
import { getState, noticeGate, setState, useStore } from './store';
import type { AppState } from './store';
import type { ToolId } from './types';

type Run = () => unknown;

interface Session {
  run: Run;
  tool: ToolId;
  repairTab: AppState['repairTab'];
  snap: unknown[];
}

let session: Session | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let again = false;

const DELAY = 350;
/** display-only settings that should not re-run a preview */
const IGNORE = new Set(['highlight', 'normals']);

function snapshot(s: AppState): unknown[] {
  const out: unknown[] = [];
  for (const [k, v] of Object.entries(s.settings)) if (!IGNORE.has(k)) out.push(v);
  out.push(s.facePicks, s.pointPicks, s.blendEdges, s.cutPlane, s.triEdit?.tris, s.perfPoints);
  return out;
}

export function liveActive() {
  return !!session;
}

/** Start a preview and keep it live. */
export function live(run: Run) {
  const s = getState();
  session = { run, tool: s.tool, repairTab: s.repairTab, snap: snapshot(s) };
  return run();
}

export function endLive() {
  session = null;
  again = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

async function rerun() {
  timer = null;
  if (!session) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  const sess = session;
  const before = getState().preview;
  try {
    // warnings come from the synchronous input checks at the start of a preview
    noticeGate.quiet = true;
    const p = sess.run();
    noticeGate.quiet = false;
    await p;
  } finally {
    noticeGate.quiet = false;
    running = false;
  }
  // the inputs are not valid any more (nothing new was produced): drop the stale preview
  if (session === sess && getState().preview === before && before) setState({ preview: null });
  if (again && session) {
    again = false;
    rerun();
  }
}

useStore.subscribe((s, prev) => {
  if (!session) return;
  // switching tool / repair tab ends the live session
  if (s.tool !== session.tool || s.repairTab !== session.repairTab) return endLive();
  if (s.settings === prev.settings && s.facePicks === prev.facePicks && s.pointPicks === prev.pointPicks && s.blendEdges === prev.blendEdges && s.cutPlane === prev.cutPlane && s.triEdit === prev.triEdit && s.perfPoints === prev.perfPoints)
    return;
  const snap = snapshot(s);
  if (snap.length === session.snap.length && snap.every((v, i) => v === session!.snap[i])) return;
  session.snap = snap;
  if (timer) clearTimeout(timer);
  timer = setTimeout(rerun, DELAY);
});
