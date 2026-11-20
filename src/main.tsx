import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { watchForUpdates } from './state/updateCheck';
import './ui/styles.css';
import { getState } from './state/store';
import { applyUiTheme } from './state/theme';

applyUiTheme(getState().appearance);
watchForUpdates();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
