import type { ViewName } from '../state/types';

/** Imperative handle to the viewer, set by the canvas component. */
export interface ViewerApi {
  fitView: (selectionOnly?: boolean) => void;
  setView: (v: ViewName) => void;
}

export const viewerApi: { current: ViewerApi | null } = { current: null };
