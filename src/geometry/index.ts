/**
 * Geometry module: plain functions over MeshData, with no UI dependencies.
 * Everything here runs in Web Workers, the main thread or Node (tests), so it
 * can be reused by other tools (e.g. a future automatic nesting module).
 */
export * from './mesh';
export * from './weld';
export * from './topology';
export * from './measure';
export * from './transform';
export * from './analysis';
export * from './holes';
export * from './repair';
export * from './cut';
export * from './select';
export * from './features';
export * from './extrude';
export * from './primitives';
export * from './hollow';
export * from './perforate';
export * from './sdf';
export * from './marching';
export * from './triangulate';
export * from './manifold';
