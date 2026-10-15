/**
 * Everything the views share about one opened file: the bytes, the header read from them, the
 * schema read straight from the pages, the WAL if one was given, the SQL engine (opened the first
 * time a view needs it) and the carver's result (computed the first time it is asked for).
 */
import { ToolError } from '../../core/errors';
import { carveFile, type CarveResult } from './_sqlite-carve';
import { openDatabase, type Database } from './_sqlite-engine';
import { openFile, readSchema, type SchemaEntry, type SqliteFile } from './_sqlite-format';
import { applyWal, parseWal, type AppliedWal, type WalInfo } from './_sqlite-wal';
import { toolT } from '../../i18n/tool-text';

const T = toolT('sqlite');

export interface WalState {
  info: WalInfo;
  bytes: Uint8Array;
  /** Set when the frames were written over a copy of the database. */
  applied: AppliedWal | null;
  /** The log was made for another page size: it cannot belong to this database. */
  mismatch: boolean;
}

export interface Context {
  name: string | undefined;
  /** The file exactly as it was given. */
  original: Uint8Array;
  /** The pages every view reads: the file, or the file with the WAL frames written over it. */
  file: SqliteFile;
  schema: SchemaEntry[];
  schemaProblems: string[];
  wal: WalState | null;
  /** The SQL engine's view of the database, or null (see `dbError`). */
  db(): Promise<Database | null>;
  readonly dbError: string | null;
  carve(): CarveResult;
  close(): void;
}

export function createContext(
  bytes: Uint8Array,
  name: string | undefined,
  walInput: { bytes: Uint8Array } | null,
  applyLog: boolean,
): Context {
  const original = bytes;
  const base = openFile(bytes);
  if (!base) throw new ToolError(T('error.badHeader'));

  let wal: WalState | null = null;
  let work = bytes;
  if (walInput) {
    const info = parseWal(walInput.bytes);
    if (!info) throw new ToolError(T('error.notWal'));
    const mismatch = info.header.pageSize !== base.pageSize;
    let applied: AppliedWal | null = null;
    if (!mismatch && applyLog && info.committedFrames > 0) {
      applied = applyWal(bytes, walInput.bytes, info);
      work = applied.bytes;
    }
    wal = { info, bytes: walInput.bytes, applied, mismatch };
  }
  const file = work === bytes ? base : (openFile(work) ?? base);
  const { entries, problems } = readSchema(file);

  let database: Database | null = null;
  let opened: Promise<Database | null> | null = null;
  let dbError: string | null = null;
  let carved: CarveResult | null = null;

  return {
    name,
    original,
    file,
    schema: entries,
    schemaProblems: problems,
    wal,
    db() {
      opened ??= openDatabase(work).then(
        (d) => (database = d),
        (e: unknown) => {
          dbError = e instanceof Error ? e.message : String(e);
          return null;
        },
      );
      return opened;
    },
    get dbError() {
      return dbError;
    },
    carve() {
      carved ??= carveFile(file, { schema: entries });
      return carved;
    },
    close() {
      database?.close();
      database = null;
    },
  };
}
