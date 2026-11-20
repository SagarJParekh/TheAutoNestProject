import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * If drawing the app fails, show what went wrong (and a way back) instead of
 * a blank page: the error, Reload, and Copy details to send for a fix.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; info: string }> {
  state = { error: null as Error | null, info: '' };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('AutoNest crashed:', error, info.componentStack);
    this.setState({ info: info.componentStack ?? '' });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    const details = `${error.name}: ${error.message}\n${error.stack ?? ''}\n\nComponents:${info}\n\nVersion: ${document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? 'dev'}\nBrowser: ${navigator.userAgent}`;
    return (
      <div className="crash-screen">
        <div className="crash-card">
          <h1>Something went wrong</h1>
          <p>
            AutoNest hit an error and stopped drawing. Reloading usually fixes it (your Build generation session is kept). If it happens again, copy the
            details and send them so it can be fixed.
          </p>
          <pre>{`${error.name}: ${error.message}`}</pre>
          <div className="crash-actions">
            <button className="btn primary" onClick={() => location.reload()}>
              Reload
            </button>
            <button className="btn" onClick={() => void navigator.clipboard?.writeText(details)}>
              Copy details
            </button>
            <button className="btn" onClick={() => this.setState({ error: null, info: '' })} title="Try to carry on without reloading">
              Try to continue
            </button>
          </div>
        </div>
      </div>
    );
  }
}
