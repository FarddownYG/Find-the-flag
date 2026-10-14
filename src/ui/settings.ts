import { buildFlagRegex } from '../core/flags';

/** Per-browser conveniences only (localStorage). Nothing ever leaves the page. */
const KEY = 'ftf.flagPattern';

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

let custom = read();
let regex = buildFlagRegex(custom);
const listeners = new Set<() => void>();

export const flagSettings = {
  get pattern() {
    return custom;
  },
  get regex() {
    return regex;
  },
  set(pattern: string) {
    custom = pattern;
    regex = buildFlagRegex(pattern);
    try {
      localStorage.setItem(KEY, pattern);
    } catch {
      // Storage blocked (private mode): the setting just lasts for this tab.
    }
    listeners.forEach((l) => l());
  },
  onChange(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
