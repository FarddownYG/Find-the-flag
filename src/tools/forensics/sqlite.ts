import { bool, defineTool, file, number, select, text } from '../../core/define';
import { toolT } from '../../i18n/tool-text';
import { hasSqliteMagic } from './_sqlite-format';

const T = toolT('sqlite');

const inMode = (values: Record<string, unknown>, ...modes: string[]) =>
  modes.includes(String(values.mode));

const WAL_MAGICS = [0x377f0682, 0x377f0683];

export default defineTool({
  id: 'sqlite',
  name: 'SQLite database',
  category: 'forensics',
  description:
    'Open a SQLite database (browser history, app data, CTF .db files): tables, BLOBs, read-only SQL, deleted rows left in the file, WAL.',
  tags: [
    'sqlite3',
    'sqlite',
    'db',
    'database',
    'sql',
    'browser history',
    'chrome history',
    'firefox places',
    'moz_places',
    'wal',
    'write-ahead log',
    'deleted rows',
    'undelete',
    'freelist',
    'blob',
    'sqlitebrowser',
    'dbeaver',
  ],
  input: 'file',
  placeholder: 'Open a .db / .sqlite file (or its -wal file)',
  options: {
    mode: select(
      'View',
      [
        { value: 'overview', label: 'Overview' },
        { value: 'browse', label: 'Browse a table' },
        { value: 'sql', label: 'SQL (read-only)' },
        { value: 'deleted', label: 'Deleted records' },
        { value: 'wal', label: 'Write-ahead log' },
        { value: 'history', label: 'Browser history' },
        { value: 'flags', label: 'Find flags' },
      ],
      'overview',
    ),
    table: text('Table or view', '', {
      placeholder: 'notes',
      hint: 'Name of the table or view to show. Left empty, the tables are listed to pick from.',
      showIf: (v) => inMode(v, 'browse'),
    }),
    sql: text('SQL', '', {
      placeholder: 'SELECT * FROM notes LIMIT 10',
      hint: 'One statement: SELECT, WITH, VALUES, EXPLAIN or a read-only PRAGMA. Anything that writes, attaches a file or loads an extension is refused.',
      showIf: (v) => inMode(v, 'sql'),
    }),
    page: number('Page', 1, {
      min: 1,
      hint: 'Page of rows to show (the buttons under the table change it).',
      showIf: (v) => inMode(v, 'browse', 'sql', 'history'),
    }),
    rows: number('Rows per page', 50, {
      min: 1,
      max: 500,
      showIf: (v) => inMode(v, 'browse', 'sql', 'history'),
    }),
    wal: file('WAL file', 'bytes', {
      hint: 'The -wal file that sat next to the database. Its committed frames are the newer state of the data.',
    }),
    applyWal: bool('Apply the WAL frames', true, {
      hint: 'Show the database as a reader would see it with the log. Off: the file alone.',
      showIf: (v) => v.wal !== null && v.wal !== undefined,
    }),
    flagPattern: text('Flag pattern', '', {
      placeholder: 'FTF\\{[^}]+\\}',
      hint: 'A regular expression for your event’s flag format; flag{…}-style shapes are always searched.',
      showIf: (v) => inMode(v, 'overview', 'flags'),
    }),
  },
  examples: [
    {
      label: 'Open an app database',
      input: { sample: 'sqlite-app.db' },
      expect: 'FTF{sqlite_demo}',
    },
    {
      label: 'Browse a table',
      input: { sample: 'sqlite-app.db' },
      options: { mode: 'browse', table: 'notes' },
      expect: 'Shopping list',
    },
    {
      label: 'Read-only SQL query',
      input: { sample: 'sqlite-app.db' },
      options: { mode: 'sql', sql: 'SELECT author, count(*) AS notes FROM notes GROUP BY author' },
      expect: 'alice',
    },
    {
      label: 'A PNG stored as a BLOB',
      input: { sample: 'sqlite-blob.db' },
      options: { mode: 'browse', table: 'files' },
      expect: 'PNG image',
    },
    {
      label: 'A row that was DELETEd',
      input: { sample: 'sqlite-deleted.db' },
      options: { mode: 'deleted' },
      expect: 'FTF{deleted_row}',
    },
    {
      label: 'Chrome history with UTC times',
      input: { sample: 'sqlite-chrome-history.db' },
      options: { mode: 'history' },
      expect: '2024-03-14T09:26:53',
    },
    {
      label: 'Firefox history with UTC times',
      input: { sample: 'sqlite-firefox-places.db' },
      options: { mode: 'history' },
      expect: '2023-11-14T22:13:20',
    },
    {
      label: 'The newer state from a -wal file',
      input: { sample: 'sqlite-wal.db' },
      options: { wal: { sample: 'sqlite-wal.db-wal' }, mode: 'wal' },
      expect: 'FTF{in_the_wal}',
    },
    {
      label: 'A -wal file opened on its own',
      input: { sample: 'sqlite-wal.db-wal' },
      expect: 'FTF{in_the_wal}',
    },
    {
      label: 'Search every cell for flags',
      input: { sample: 'sqlite-deleted.db' },
      options: { mode: 'flags' },
      expect: 'FTF{deleted_row}',
    },
  ],
  async run(input, opts) {
    const { runSqlite } = await import('./_sqlite-run');
    return runSqlite(input, opts);
  },
  detect({ bytes }) {
    if (hasSqliteMagic(bytes)) return { score: 0.95, reason: T('detect.database') };
    if (bytes.length >= 32) {
      const magic = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
      if (WAL_MAGICS.includes(magic)) return { score: 0.9, reason: T('detect.wal') };
    }
    return null;
  },
});
