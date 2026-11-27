/**
 * A file or an analysis held in memory is lost on close/reload: ask the browser to confirm, but only
 * while something is held. In-app navigation (hash routes) never fires `beforeunload`.
 */
const holders = new Set<symbol>();
let installed = false;

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (holders.size === 0) return;
  e.preventDefault();
  e.returnValue = '';
}

/** `owner` says whether it currently holds a file; call again with false to release. */
export function holdFile(owner: symbol, held: boolean): void {
  if (held) holders.add(owner);
  else holders.delete(owner);
  if (!installed && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload);
    installed = true;
  }
}

export const isHoldingFile = (): boolean => holders.size > 0;
