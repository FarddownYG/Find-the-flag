import { describe, expect, it } from 'vitest';
import {
  RESOURCE_CATEGORIES,
  RESOURCE_KINDS,
  RESOURCE_SOURCE,
  RESOURCES,
  type Resource,
} from './data';

describe('the resource directory', () => {
  it('has exactly 63 entries (65 from the source minus Skrapp and Epieos)', () => {
    expect(RESOURCES).toHaveLength(63);
  });

  it('has a unique id for every entry', () => {
    const ids = RESOURCES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses only valid, kebab-case ids', () => {
    for (const r of RESOURCES) expect(r.id, r.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('has an http(s) URL for every entry', () => {
    for (const r of RESOURCES) {
      expect(() => new URL(r.url), `${r.id}: ${r.url}`).not.toThrow();
      expect(r.url, r.id).toMatch(/^https?:\/\//);
    }
  });

  it('puts every entry in a known category and kind', () => {
    for (const r of RESOURCES) {
      expect(RESOURCE_CATEGORIES as readonly string[], r.id).toContain(r.category);
      expect(RESOURCE_KINDS as readonly string[], r.id).toContain(r.kind);
    }
  });

  it('gives every entry a non-empty name, description and source', () => {
    for (const r of RESOURCES) {
      expect(r.name.trim(), r.id).not.toBe('');
      expect(r.description.trim(), r.id).not.toBe('');
      expect(r.source, r.id).toBe(RESOURCE_SOURCE);
    }
  });

  it('leaves out the two out-of-scope OSINT people-search entries', () => {
    const names = RESOURCES.map((r) => r.name.toLowerCase());
    expect(names).not.toContain('skrapp (linkedin email finder)');
    expect(names.some((n) => n.includes('epieos'))).toBe(false);
  });

  it('covers every category with at least one entry', () => {
    for (const cat of RESOURCE_CATEGORIES) {
      expect(
        RESOURCES.some((r: Resource) => r.category === cat),
        cat,
      ).toBe(true);
    }
  });
});
