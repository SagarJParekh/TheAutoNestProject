import type { LoaderModule } from './types';

const loaders = new Map<string, LoaderModule>();

/** Register a loader for its extensions. Adding a format = one module + one call. */
export function registerLoader(loader: LoaderModule) {
  for (const ext of loader.extensions) loaders.set(ext.toLowerCase(), loader);
}

export function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i < 0 ? '' : fileName.slice(i + 1).toLowerCase();
}

export function getLoader(fileName: string): LoaderModule | undefined {
  return loaders.get(extensionOf(fileName));
}

export function registeredLoaders(): LoaderModule[] {
  return Array.from(new Set(loaders.values()));
}

/** Extensions that can actually be imported (for the file picker accept list). */
export function importableExtensions(): string[] {
  return Array.from(loaders.entries())
    .filter(([, l]) => l.load)
    .map(([e]) => e);
}
