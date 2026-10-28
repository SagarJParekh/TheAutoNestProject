/**
 * Saving files: ask where to save (file picker), save into a chosen folder,
 * or the browser's Downloads folder.
 *
 * Choosing a location uses the File System Access API (Chrome, Edge, Opera).
 * Browsers without it (Firefox, Safari) always save to Downloads.
 *
 * The location has to be picked while the click that started the export is
 * still "fresh" (browsers only open pickers in direct response to a click),
 * so callers pick the target first, then generate the file, then write it.
 */
import { notify } from './store';

export type SaveMode = 'ask' | 'folder' | 'downloads';

/* minimal typings for the File System Access API */
interface FsWritable {
  write(data: Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  name: string;
  createWritable(): Promise<FsWritable>;
}
interface FsDirHandle {
  name: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
}
type FsWindow = Window & {
  showSaveFilePicker?: (o: unknown) => Promise<FsFileHandle>;
  showDirectoryPicker?: (o?: unknown) => Promise<FsDirHandle>;
};

const w = (typeof window === 'undefined' ? {} : window) as FsWindow;
export const canPickLocation = typeof w.showSaveFilePicker === 'function';
export const canPickFolder = typeof w.showDirectoryPicker === 'function';

const MODE_KEY = 'autonest.saveMode';
export function getSaveMode(): SaveMode {
  let m: string | null = null;
  try {
    m = localStorage.getItem(MODE_KEY);
  } catch {
    // storage blocked
  }
  const mode = (m as SaveMode) || (canPickLocation ? 'ask' : 'downloads');
  if (mode === 'ask' && !canPickLocation) return 'downloads';
  if (mode === 'folder' && !canPickFolder) return 'downloads';
  return mode;
}
export function setSaveMode(m: SaveMode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // storage blocked: the choice lasts for this session only
  }
  sessionMode = m;
}
let sessionMode: SaveMode | null = null;
export function saveMode(): SaveMode {
  return sessionMode ?? getSaveMode();
}

// ---------------------------------------------------------------- remembered folder (IndexedDB)

let folder: FsDirHandle | null = null;
const DB = 'autonest', STORE = 'handles';

function idb<T>(fn: (s: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      };
    } catch {
      resolve(undefined);
    }
  });
}

export async function savedFolder(): Promise<FsDirHandle | null> {
  if (folder) return folder;
  folder = ((await idb((s) => s.get('exportFolder'), 'readonly')) as FsDirHandle | undefined) ?? null;
  return folder;
}

/** Let the user choose the export folder (must run from a click). */
export async function chooseFolder(): Promise<string | null> {
  if (!canPickFolder) return null;
  try {
    const h = await w.showDirectoryPicker!({ id: 'autonest-export', mode: 'readwrite' });
    folder = h;
    await idb((s) => s.put(h, 'exportFolder'), 'readwrite');
    setSaveMode('folder');
    return h.name;
  } catch {
    return null; // cancelled
  }
}

export function folderName(): string | null {
  return folder?.name ?? null;
}

// ---------------------------------------------------------------- targets

export type SaveTarget = { kind: 'file'; handle: FsFileHandle } | { kind: 'folder'; dir: FsDirHandle; name: string } | { kind: 'download'; name: string };

const TYPES: Record<string, { description: string; accept: Record<string, string[]> }> = {
  stl: { description: 'STL mesh', accept: { 'model/stl': ['.stl'] } },
  '3mf': { description: '3MF model', accept: { 'model/3mf': ['.3mf'] } },
  obj: { description: 'OBJ mesh', accept: { 'model/obj': ['.obj'] } },
  zip: { description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } },
  slc: { description: 'SLC slice contours', accept: { 'application/octet-stream': ['.slc'] } },
  csv: { description: 'CSV table', accept: { 'text/csv': ['.csv'] } },
};

/**
 * Decide where `name` goes. Call it straight from the click handler, before
 * any slow work. Returns null when the user cancelled the picker.
 */
export async function pickSaveTarget(name: string): Promise<SaveTarget | null> {
  const mode = saveMode();
  if (mode === 'ask' && canPickLocation) {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    try {
      const handle = await w.showSaveFilePicker!({ suggestedName: name, id: 'autonest-export', types: TYPES[ext] ? [TYPES[ext]] : undefined });
      return { kind: 'file', handle };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
      return { kind: 'download', name };
    }
  }
  if (mode === 'folder') {
    const dir = await savedFolder();
    if (dir) {
      let ok: PermissionState = (await dir.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
      if (ok !== 'granted') ok = (await dir.requestPermission?.({ mode: 'readwrite' }).catch(() => 'denied' as PermissionState)) ?? 'denied';
      if (ok === 'granted') return { kind: 'folder', dir, name };
      notify('warning', `No permission to save into “${dir.name}”; saving to Downloads instead`);
    }
  }
  return { kind: 'download', name };
}

/** Write the bytes to a target picked earlier. Returns a short description of where it went. */
export async function writeSaveTarget(target: SaveTarget, data: BlobPart, mime = 'application/octet-stream'): Promise<string> {
  const blob = new Blob([data], { type: mime });
  try {
    if (target.kind === 'file') {
      const out = await target.handle.createWritable();
      await out.write(blob);
      await out.close();
      return target.handle.name;
    }
    if (target.kind === 'folder') {
      const fh = await target.dir.getFileHandle(target.name, { create: true });
      const out = await fh.createWritable();
      await out.write(blob);
      await out.close();
      return `${target.dir.name}/${target.name}`;
    }
  } catch (e) {
    notify('warning', `Could not save there (${(e as Error).message}); saving to Downloads instead`);
  }
  const name = target.kind === 'download' ? target.name : target.kind === 'folder' ? target.name : target.handle.name;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return `Downloads/${name}`;
}

/** Pick and write in one go (for files that are ready straight away). */
export async function saveFile(name: string, data: BlobPart, mime?: string): Promise<string | null> {
  const t = await pickSaveTarget(name);
  if (!t) return null;
  return writeSaveTarget(t, data, mime);
}

// ---------------------------------------------------------------- several files into one folder

export type FolderTarget = { kind: 'folder'; dir: FsDirHandle } | { kind: 'downloads' };

/**
 * Where separate files go: the export folder chosen in "Save to" (if that is the
 * mode and access is still allowed), otherwise a folder picked now. Browsers
 * without folder access download every file. Null when the picker was cancelled.
 */
export async function pickExportFolder(): Promise<FolderTarget | null> {
  if (!canPickFolder) return { kind: 'downloads' };
  if (saveMode() === 'folder') {
    const dir = await savedFolder();
    if (dir) {
      let ok: PermissionState = (await dir.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
      if (ok !== 'granted') ok = (await dir.requestPermission?.({ mode: 'readwrite' }).catch(() => 'denied' as PermissionState)) ?? 'denied';
      if (ok === 'granted') return { kind: 'folder', dir };
    }
  }
  try {
    const dir = await w.showDirectoryPicker!({ id: 'autonest-export', mode: 'readwrite' });
    folder = dir;
    await idb((st) => st.put(dir, 'exportFolder'), 'readwrite');
    return { kind: 'folder', dir };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    return { kind: 'downloads' };
  }
}

/** Write one file of a set into the folder picked with pickExportFolder. */
export function writeIntoFolder(t: FolderTarget, name: string, data: BlobPart): Promise<string> {
  return writeSaveTarget(t.kind === 'folder' ? { kind: 'folder', dir: t.dir, name } : { kind: 'download', name }, data);
}
