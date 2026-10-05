import type { ReactNode } from 'react';

const P = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);

export const Icon = {
  open: P(<><path d="M3 7h6l2 2h10v10H3z" /><path d="M12 12v5M9.5 14.5 12 12l2.5 2.5" /></>),
  export: P(<><path d="M12 3v12M7 8l5-5 5 5" /><path d="M4 15v5h16v-5" /></>),
  undo: P(<><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-4" /></>),
  redo: P(<><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h4" /></>),
  move: P(<><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" /></>),
  rotate: P(<><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></>),
  fit: P(<><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /><rect x="8" y="8" width="8" height="8" rx="1" /></>),
  eye: P(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>),
  eyeOff: P(<><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6" /></>),
  lock: P(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>),
  unlock: P(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" /></>),
  trash: P(<><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>),
  copy: P(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>),
  clip: P(<><path d="M3 12h18" strokeDasharray="3 2" /><path d="M6 12V6h12v6" /></>),
  cut: P(<><circle cx="6" cy="18" r="3" /><circle cx="18" cy="18" r="3" /><path d="M8 16 20 4M16 16 4 4" /></>),
  repair: P(<><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" /></>),
  hollow: P(<><rect x="3" y="3" width="18" height="18" rx="2" /><rect x="8" y="8" width="8" height="8" rx="1" strokeDasharray="2 2" /></>),
  perforate: P(<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="1.5" /><circle cx="16" cy="8" r="1.5" /><circle cx="8" cy="16" r="1.5" /><circle cx="16" cy="16" r="1.5" /><circle cx="12" cy="12" r="1.5" /></>),
  extrude: P(<><path d="M4 16l8 4 8-4M4 16V12l8 4 8-4v4" /><path d="M12 12V3M9 6l3-3 3 3" /></>),
  transform: P(<><path d="M5 19 19 5M14 5h5v5M5 14v5h5" /></>),
  layflat: P(<><path d="M3 20h18" /><path d="M7 16 12 6l5 10z" /></>),
  help: P(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01" /></>),
  close: P(<path d="M6 6l12 12M18 6 6 18" />),
  grid: P(<><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></>),
  label: P(<><path d="M4 7V4h16v3M12 4v16M9 20h6" /></>),
  texture: P(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9l6-6M3 15 15 3M3 21 21 3M9 21l12-12M15 21l6-6" /></>),
  measure: P(<><path d="M3 17 17 3l4 4L7 21z" /><path d="M7 13l2 2M10 10l2 2M13 7l2 2" /></>),
  zoomArea: P(<><rect x="3" y="3" width="12" height="12" rx="1" strokeDasharray="3 2" /><circle cx="16" cy="16" r="3.5" /><path d="m19 19 2.5 2.5" /></>),
  cube: P(<><path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="M3 7l9 5 9-5M12 12v10" /></>),
};
