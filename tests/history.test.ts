import { describe, expect, it, beforeEach } from 'vitest';
import { commit, getState, redo, setState, undo, updateParts } from '../src/state/store';
import type { Part } from '../src/state/types';
import { cube } from './fixtures/meshes';

const part = (id: string): Part => ({
  id,
  name: id,
  color: '#fff',
  visible: true,
  locked: false,
  mesh: cube(),
  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
});

describe('undo / redo history', () => {
  beforeEach(() => setState({ parts: [], past: [], future: [], selection: [] }));

  it('undoes and redoes commits in order', () => {
    commit('Add a', [part('a')]);
    commit('Add b', [...getState().parts, part('b')]);
    updateParts('Move a', ['a'], (p) => ({ ...p, transform: { ...p.transform, position: [5, 0, 0] } }));
    expect(getState().parts[0].transform.position[0]).toBe(5);
    undo();
    expect(getState().parts[0].transform.position[0]).toBe(0);
    undo();
    expect(getState().parts.map((p) => p.id)).toEqual(['a']);
    redo();
    expect(getState().parts.map((p) => p.id)).toEqual(['a', 'b']);
    redo();
    expect(getState().parts[0].transform.position[0]).toBe(5);
    redo(); // nothing left
    expect(getState().future.length).toBe(0);
  });

  it('drops the redo stack on a new commit and prunes the selection', () => {
    commit('Add a', [part('a')], { selection: ['a'] });
    commit('Add b', [...getState().parts, part('b')], { selection: ['b'] });
    undo();
    expect(getState().selection).toEqual([]);
    commit('Add c', [...getState().parts, part('c')]);
    expect(getState().future.length).toBe(0);
    expect(getState().past.map((h) => h.label)).toEqual(['Add a', 'Add c']);
  });

  it('shares mesh buffers between history entries (no copies)', () => {
    const a = part('a');
    commit('Add a', [a]);
    updateParts('Rename', ['a'], (p) => ({ ...p, name: 'x' }));
    expect(getState().past[1].parts[0].mesh).toBe(getState().parts[0].mesh);
  });
});
