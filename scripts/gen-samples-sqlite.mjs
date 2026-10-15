// Generates the SQLite sample files of the "SQLite database" tool in public/samples/.
// Deterministic: run it again and the bytes are identical. Everything in them is made up (the
// users, the URLs, the "flags"). The databases are written by sql.js (SQLite compiled to
// WebAssembly), the same engine the tool uses, so they are real SQLite files.
//
//   node scripts/gen-samples-sqlite.mjs
//
// Files:
//   sqlite-app.db              a small app database: notes (one holds FTF{sqlite_demo}), users,
//                              an index, a view and a trigger; user_version 3
//   sqlite-blob.db             a table of files whose BLOBs are a PNG, a GIF and a text file
//   sqlite-deleted.db          a row holding FTF{deleted_row} that was DELETEd (no VACUUM), the
//                              last row too, and a dropped table (its pages are on the freelist)
//   sqlite-chrome-history.db   the tables Chrome's History uses (urls, visits, downloads, ...)
//   sqlite-firefox-places.db   the tables Firefox's places.sqlite uses (moz_places, ...)
//   sqlite-wal.db              a WAL-mode database ...
//   sqlite-wal.db-wal          ... and its write-ahead log: one committed transaction (a new row
//                              holding FTF{in_the_wal}) followed by a frame of an older log
//                              generation (a row holding FTF{older_wal})
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { encode as encodePng } from 'fast-png';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const SQL = await initSqlJs();

/** Run statements, then return the file bytes. */
function build(statements, setup) {
  const db = new SQL.Database();
  for (const s of statements) db.run(s);
  setup?.(db);
  const bytes = db.export();
  db.close();
  return bytes;
}
const save = (name, bytes) => {
  writeFileSync(outDir + name, bytes);
  console.log(`${name}: ${bytes.length} bytes`);
};

// ---------- sqlite-app.db ----------

const notes = [
  ['alice', 'Shopping list', 'milk, eggs, coffee, a very long list of things nobody reads'],
  ['bob', 'Meeting notes', 'Roadmap review moved to Thursday. Bring the slides.'],
  ['alice', 'Note to self', 'The vault code is FTF{sqlite_demo}, do not share it'],
  ['carol', 'Recipe', 'Pancakes: 200 g flour, 2 eggs, 300 ml milk, a pinch of salt'],
  ['bob', 'Todo', 'Fix the printer, answer the mail, water the plants'],
  ['alice', 'Books', 'Read next: a book about birds, a book about bridges'],
  ['carol', 'Travel', 'Train to the coast at 08:15, return on Sunday evening'],
  ['bob', 'Passwords?', 'Never store them here. Use a manager.'],
];
save(
  'sqlite-app.db',
  build(
    [
      'PRAGMA user_version = 3',
      'PRAGMA application_id = 1179796992',
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, email TEXT)',
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, author TEXT NOT NULL, title TEXT, body TEXT, created TEXT)',
      'CREATE TABLE audit (id INTEGER PRIMARY KEY, what TEXT)',
      'CREATE INDEX notes_author ON notes (author)',
      'CREATE VIEW recent_notes AS SELECT id, author, title FROM notes ORDER BY id DESC LIMIT 5',
      `CREATE TRIGGER notes_log AFTER INSERT ON notes BEGIN INSERT INTO audit (what) VALUES ('note ' || new.id); END`,
      "INSERT INTO users (name, email) VALUES ('alice', 'alice@example.com'), ('bob', 'bob@example.com'), ('carol', 'carol@example.com')",
    ],
    (db) => {
      notes.forEach(([author, title, body], i) =>
        db.run('INSERT INTO notes (author, title, body, created) VALUES (?, ?, ?, ?)', [
          author,
          title,
          body,
          `2024-02-0${i + 1} 10:00:00`,
        ]),
      );
    },
  ),
);

// ---------- sqlite-blob.db ----------

const png = encodePng({
  width: 16,
  height: 16,
  depth: 8,
  channels: 4,
  data: Uint8Array.from({ length: 16 * 16 * 4 }, (_, i) => {
    const px = i >> 2;
    const [x, y] = [px % 16, px >> 4];
    return [x * 16, y * 16, 128, 255][i & 3];
  }),
});
const gif = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);
save(
  'sqlite-blob.db',
  build(['CREATE TABLE files (id INTEGER PRIMARY KEY, name TEXT, mime TEXT, data BLOB)'], (db) => {
    db.run('INSERT INTO files (name, mime, data) VALUES (?, ?, ?)', ['logo.png', 'image/png', png]);
    db.run('INSERT INTO files (name, mime, data) VALUES (?, ?, ?)', [
      'pixel.gif',
      'image/gif',
      gif,
    ]);
    db.run('INSERT INTO files (name, mime, data) VALUES (?, ?, ?)', [
      'readme.txt',
      'text/plain',
      new TextEncoder().encode('Nothing to see here.\nFTF{blob_text}\n'),
    ]);
  }),
);

// ---------- sqlite-deleted.db ----------

const chat = [
  ['dave', 'Are we still on for lunch?'],
  ['erin', 'Yes, 12:30 at the usual place'],
  ['dave', 'Great. Did you read the report?'],
  ['erin', 'Only the summary. Looks fine.'],
  ['dave', 'The access token is FTF{deleted_row}, delete this after reading'],
  ['erin', 'Done, it is gone'],
  ['dave', 'Perfect, see you at noon'],
  ['erin', 'Bring an umbrella, it will rain'],
  ['dave', 'Last message: see you there'],
];
save(
  'sqlite-deleted.db',
  build(
    [
      'CREATE TABLE messages (id INTEGER PRIMARY KEY, sender TEXT, body TEXT)',
      'CREATE TABLE secrets (id INTEGER PRIMARY KEY, label TEXT, value TEXT)',
    ],
    (db) => {
      for (const [sender, body] of chat) {
        db.run('INSERT INTO messages (sender, body) VALUES (?, ?)', [sender, body]);
      }
      for (let i = 1; i <= 90; i++) {
        db.run('INSERT INTO secrets (label, value) VALUES (?, ?)', [
          `entry ${i}`,
          i === 17
            ? 'archived credential FTF{freelist_page} for the old server, kept in the table for later'
            : `archived value ${i} for the old server, kept in the table for later reference`,
        ]);
      }
      // No VACUUM, no secure_delete: the bytes of these rows stay in the file.
      db.run('DELETE FROM messages WHERE id = 5');
      db.run('DELETE FROM messages WHERE id = 9');
      db.run('DROP TABLE secrets');
    },
  ),
);

// ---------- browser histories ----------

const WEBKIT_OFFSET = 11_644_473_600n; // seconds from 1601 to 1970
const webkit = (unix, micros = 0) =>
  String((BigInt(unix) + WEBKIT_OFFSET) * 1_000_000n + BigInt(micros));
const prtime = (unix, micros = 0) => String(BigInt(unix) * 1_000_000n + BigInt(micros));

const sites = [
  ['https://www.example.com/', 'Example Domain'],
  ['https://ctf.example.org/challenges', 'Challenges'],
  ['https://docs.example.net/sqlite/wal', 'Write-ahead logging'],
  ['https://mail.example.com/inbox', 'Inbox'],
];
// Unix seconds of the visits (2024-03-14 09:26:53 UTC is the first).
const visitTimes = [1710408413, 1710408905, 1710412000, 1710415530, 1710499999, 1710500500];
// [site index, transition]
const visitPlan = [
  [0, 1],
  [1, 0],
  [2, 0],
  [1, 0],
  [3, 1],
  [2, 8],
];

save(
  'sqlite-chrome-history.db',
  build(
    [
      'CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)',
      'CREATE TABLE urls (id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)',
      'CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, from_visit INTEGER, transition INTEGER DEFAULT 0 NOT NULL, segment_id INTEGER, visit_duration INTEGER DEFAULT 0 NOT NULL)',
      'CREATE TABLE keyword_search_terms (keyword_id INTEGER NOT NULL, url_id INTEGER NOT NULL, term LONGVARCHAR NOT NULL, normalized_term LONGVARCHAR NOT NULL)',
      'CREATE TABLE downloads (id INTEGER PRIMARY KEY, guid VARCHAR NOT NULL, current_path LONGVARCHAR NOT NULL, target_path LONGVARCHAR NOT NULL, start_time INTEGER NOT NULL, received_bytes INTEGER NOT NULL, total_bytes INTEGER NOT NULL, state INTEGER NOT NULL, end_time INTEGER NOT NULL, tab_url VARCHAR)',
    ],
    (db) => {
      const counts = sites.map((_, s) => visitPlan.filter(([i]) => i === s).length);
      sites.forEach(([url, title], s) => {
        const last = Math.max(...visitPlan.flatMap(([i], k) => (i === s ? [visitTimes[k]] : [])));
        db.run(
          'INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time) VALUES (?, ?, ?, ?, ?)',
          [url, title, counts[s], s === 0 ? 1 : 0, webkit(last, 123456)],
        );
      });
      visitPlan.forEach(([s, transition], k) =>
        db.run('INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, ?)', [
          s + 1,
          webkit(visitTimes[k], k === 0 ? 123456 : 0),
          transition,
        ]),
      );
      db.run(
        "INSERT INTO keyword_search_terms VALUES (2, 2, 'ctf sqlite forensics', 'ctf sqlite forensics')",
      );
      db.run(
        "INSERT INTO keyword_search_terms VALUES (2, 3, 'sqlite wal checkpoint', 'sqlite wal checkpoint')",
      );
      db.run(
        'INSERT INTO downloads (guid, current_path, target_path, start_time, received_bytes, total_bytes, state, end_time, tab_url) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
        [
          '00000000-0000-4000-8000-000000000001',
          '/mnt/data/Downloads/challenge.zip',
          '/mnt/data/Downloads/challenge.zip',
          webkit(1710412100),
          20480,
          20480,
          webkit(1710412111),
          'https://ctf.example.org/challenges',
        ],
      );
    },
  ),
);

save(
  'sqlite-firefox-places.db',
  build(
    [
      'CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, rev_host LONGVARCHAR, visit_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0 NOT NULL, typed INTEGER DEFAULT 0 NOT NULL, frecency INTEGER DEFAULT -1 NOT NULL, last_visit_date INTEGER, guid TEXT)',
      'CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER, visit_date INTEGER, visit_type INTEGER, session INTEGER)',
    ],
    (db) => {
      sites.forEach(([url, title], s) => {
        const times = visitPlan.flatMap(([i], k) => (i === s ? [1700000000 + k * 600] : []));
        db.run(
          'INSERT INTO moz_places (url, title, visit_count, last_visit_date, guid) VALUES (?, ?, ?, ?, ?)',
          [url, title, times.length, prtime(Math.max(...times), 250000), `guid${s}aaaaaaaa`],
        );
      });
      visitPlan.forEach(([s, transition], k) =>
        db.run(
          'INSERT INTO moz_historyvisits (from_visit, place_id, visit_date, visit_type, session) VALUES (0, ?, ?, ?, 0)',
          [s + 1, prtime(1700000000 + k * 600, k === 0 ? 250000 : 0), transition === 1 ? 2 : 1],
        ),
      );
    },
  ),
);

// ---------- sqlite-wal.db and sqlite-wal.db-wal ----------

/** Header bytes 18 and 19 set to 2: the file says it is in WAL mode. */
function asWalMode(bytes) {
  const out = Uint8Array.from(bytes);
  out[18] = 2;
  out[19] = 2;
  return out;
}

const walSchema = ['CREATE TABLE notes (id INTEGER PRIMARY KEY, author TEXT, body TEXT)'];
const baseRows = [
  ['alice', 'The log is not part of the database file until it is checkpointed'],
  ['bob', 'A copy of the .db without its -wal is an older state'],
  ['alice', 'Always take the three files together: db, wal and shm'],
];
function walState(extra) {
  return build(walSchema, (db) => {
    baseRows.forEach((r) => db.run('INSERT INTO notes (author, body) VALUES (?, ?)', r));
    extra?.(db);
  });
}
// The database file as it was at the last checkpoint ...
const walBase = asWalMode(walState());
// ... the same database after one more transaction (the one the log holds) ...
const walNewer = asWalMode(
  walState((db) => {
    db.run("INSERT INTO notes (author, body) VALUES ('mallory', 'The flag is FTF{in_the_wal}')");
    db.run("UPDATE notes SET body = body || ' (edited)' WHERE id = 2");
  }),
);
// ... and an older generation of the log, whose frame is still sitting after the new frames.
const walOlder = asWalMode(
  walState((db) => {
    db.run("INSERT INTO notes (author, body) VALUES ('trudy', 'Old log frame: FTF{older_wal}')");
  }),
);

const PAGE = 4096;
const u32 = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
/** SQLite's WAL checksum over 32-bit words, little-endian here (magic 0x377f0682). */
function checksum(bytes, [s1, s2]) {
  for (let i = 0; i < bytes.length; i += 8) {
    const w = (o) =>
      (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
    s1 = (s1 + w(i) + s2) >>> 0;
    s2 = (s2 + w(i + 4) + s1) >>> 0;
  }
  return [s1, s2];
}
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const pageOf = (bytes, n) => bytes.subarray((n - 1) * PAGE, n * PAGE);

function makeWal(frames, salts, seed) {
  const header = concat([
    u32(0x377f0682),
    u32(3007000),
    u32(PAGE),
    u32(seed),
    u32(salts[0]),
    u32(salts[1]),
  ]);
  let sum = checksum(header, [0, 0]);
  const parts = [header, u32(sum[0]), u32(sum[1])];
  for (const { page, data, commit, salt = salts } of frames) {
    const head = concat([u32(page), u32(commit), u32(salt[0]), u32(salt[1])]);
    // The checksum covers the first 8 bytes of the frame header (page, commit), then the page.
    sum = checksum(data, checksum(head.subarray(0, 8), sum));
    parts.push(head, u32(sum[0]), u32(sum[1]), data);
  }
  return concat(parts);
}

const changed = [];
const pagesNew = walNewer.length / PAGE;
for (let p = 1; p <= pagesNew; p++) {
  const a = p * PAGE <= walBase.length ? pageOf(walBase, p) : null;
  const b = pageOf(walNewer, p);
  if (!a || a.some((v, i) => v !== b[i])) changed.push(p);
}
const frames = changed.map((p, i) => ({
  page: p,
  data: pageOf(walNewer, p),
  commit: i === changed.length - 1 ? pagesNew : 0,
}));
// The frame of the older generation: another set of salts, so a reader stops before it.
const olderSalts = [0x1badcafe, 0x0ddba11];
const olderFrame = { page: 2, data: pageOf(walOlder, 2), commit: pagesNew, salt: olderSalts };

const salts = [0x46544601, 0x00c0ffee];
const walFile = makeWal([...frames, olderFrame], salts, 7);
save('sqlite-wal.db', walBase);
save('sqlite-wal.db-wal', walFile);
