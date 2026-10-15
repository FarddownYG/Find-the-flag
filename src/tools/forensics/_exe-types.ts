/**
 * What the executable parsers return. Everything here is plain data in the file's own terms (ELF
 * type names, hex strings): the views turn it into translated output blocks, so the parsers stay
 * independent of the interface language and can be tested on their own.
 */

export type NoteLevel = 'info' | 'warn';

/** A finding about the file. The text lives in the view (one translated sentence per key). */
export type NoteKey =
  // malformed / truncated input
  | 'truncatedHeader'
  | 'badIdent'
  | 'tableTruncated'
  | 'tableOutside'
  | 'noSections'
  | 'sectionsBeyondFile'
  | 'capped'
  // ELF
  | 'stripped'
  | 'noDynamic'
  | 'staticLinked'
  | 'hasDebugInfo'
  | 'goBinary'
  | 'rpath'
  | 'execStack'
  // PE
  | 'dosOnly'
  | 'peOutsideFile'
  | 'badOptionalMagic'
  | 'dotNet'
  | 'richBad'
  | 'tlsCallbacks'
  | 'signed'
  | 'overlay'
  | 'timestampOdd'
  | 'epOutsideSections'
  | 'entryWritableSection'
  // packers: signals, and the verdict the view draws from them
  | 'looksPacked'
  | 'maybePacked'
  | 'packedUpx'
  | 'packedSection'
  | 'packedEntropy'
  | 'packedFewImports'
  | 'packedEmptyRaw'
  | 'packedNoSections'
  // Mach-O
  | 'fatBinary'
  | 'encrypted'
  | 'machoLoadTruncated';

export interface Note {
  key: NoteKey;
  level: NoteLevel;
  params?: Record<string, string | number>;
}

/** A property that checksec / PE-bear style tools report. */
export type SecState = 'enabled' | 'disabled' | 'partial' | 'full' | 'unknown' | 'info';

export type SecId =
  // ELF
  | 'nx'
  | 'pie'
  | 'relro'
  | 'canary'
  | 'fortify'
  | 'rpath'
  | 'runpath'
  | 'ibt'
  | 'shstk'
  | 'bti'
  | 'pac'
  // PE
  | 'aslr'
  | 'highEntropyVa'
  | 'dep'
  | 'cfg'
  | 'noSeh'
  | 'forceIntegrity'
  | 'appContainer'
  | 'signature'
  | 'cookie'
  // Mach-O
  | 'nxHeap'
  | 'codeSignature'
  | 'encryption';

export interface SecItem {
  id: SecId;
  state: SecState;
  /** Technical detail shown next to the state (flag name, count, list). */
  detail?: string;
}

/** Data found after the end of what the headers describe. */
export interface Trailing {
  offset: number;
  size: number;
  /** The signature the first bytes match (File type database), or null. */
  magic: { id: string; name: string } | null;
  /** Readable start of the data when it is text, else null. */
  text: string | null;
  /** First bytes as hex. */
  head: string;
  entropy: number | null;
}

export interface SectionRow {
  index: number;
  name: string;
  /** ELF section type name, Mach-O segment name, "" for PE. */
  type: string;
  addr: bigint;
  /** Size in memory. */
  vsize: bigint;
  /** File offset and size of the bytes, size 0 when the section holds nothing in the file. */
  offset: number;
  size: number;
  /** Flags as the format's own letters ("WAX", "R-X", "RW-"). */
  flags: string;
  entropy: number | null;
  /** Extra flag names (PE section characteristics), if the format has them. */
  detail?: string;
  /** Holds code / is writable, for hints. */
  exec: boolean;
  write: boolean;
  /** The bytes are outside the file (truncated or hostile header). */
  outside: boolean;
}

export interface SymbolRow {
  /** Which table: ELF ".symtab" / ".dynsym", "exports", "macho". */
  table: string;
  index: number;
  name: string;
  value: bigint;
  size: number;
  /** FUNC, OBJECT, ... */
  kind: string;
  bind: string;
  /** Section name, UND, ABS... */
  section: string;
  version: string;
  /** Imported (undefined, to be resolved by the loader) rather than defined here. */
  undefined: boolean;
}
