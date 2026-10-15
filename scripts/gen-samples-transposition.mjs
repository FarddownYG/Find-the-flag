// Prints the self-made ciphertexts used as examples and test data by the transposition tools
// (columnar, double columnar, Myszkowski, route / scytale). The ciphers are written again here,
// independently of src/, so a mistake in one implementation shows up as a mismatch in the other.
// Usage: node scripts/gen-samples-transposition.mjs

/** Columns in reading order for a key word (ties left to right). */
function order(key) {
  return [...key]
    .map((ch, i) => [ch.toUpperCase(), i])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]))
    .map(([, i]) => i);
}

/** Write row by row under the key, read the columns in key order. */
export function columnar(text, key) {
  const k = key.length;
  let out = '';
  for (const col of order(key)) for (let i = col; i < text.length; i += k) out += text[i];
  return out;
}

/** Equal key letters are read together, row by row. */
export function myszkowski(text, key) {
  const k = key.length;
  const letters = [...new Set([...key.toUpperCase()])].sort();
  let out = '';
  for (const letter of letters) {
    const cols = [...key.toUpperCase()].flatMap((ch, i) => (ch === letter ? [i] : []));
    for (let row = 0; row * k < text.length; row++) {
      for (const c of cols) if (row * k + c < text.length) out += text[row * k + c];
    }
  }
  return out;
}

/** Clockwise spiral inward from the top left of a rows x width grid, as cell indices. */
export function spiral(rows, width) {
  const grid = Array.from({ length: rows }, () => new Array(width).fill(false));
  const path = [];
  let r = 0;
  let c = 0;
  let dr = 0;
  let dc = 1;
  for (let n = 0; n < rows * width; n++) {
    grid[r][c] = true;
    path.push(r * width + c);
    if (n === rows * width - 1) break;
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nr >= rows || nc < 0 || nc >= width || grid[nr][nc]) {
      [dr, dc] = [dc, -dr];
    }
    r += dr;
    c += dc;
  }
  return path;
}

export function spiralEncrypt(text, width) {
  return spiral(text.length / width, width)
    .map((i) => text[i])
    .join('');
}

const wikipedia = 'WEAREDISCOVEREDFLEEATONCE';
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const samples = {
    // Published (Wikipedia, "Transposition cipher"): key ZEBRAS, nulls QKJEU.
    zebrasPadded: columnar(wikipedia + 'QKJEU', 'ZEBRAS'),
    zebrasIncomplete: columnar(wikipedia, 'ZEBRAS'),
    // Published (Wikipedia, double transposition): ZEBRAS then STRIPE.
    double: columnar(columnar(wikipedia, 'ZEBRAS'), 'STRIPE'),
    // Published (Wikipedia, Myszkowski): key TOMATO.
    tomato: myszkowski(wikipedia, 'TOMATO'),
    // Published (Wikipedia, scytale): "I am hurt very badly help" on a 4-row rod.
    scytale: columnar('IAMHURTVERYBADLYHELP', '12345'),
    // Self-made: an English message with a flag, 7 columns, incomplete grid.
    solve: columnar(
      'pleasemeetmeatthe' +
        'oldbridgebeforesunriseandbringthemap' +
        'thecodewordisflag{columns_in_key_order}' +
        'sokeepitsafeandtellnooneabouttheplanlater',
      'QUILTED',
    ),
    // Self-made (browser test): another English message, key STRANGE (7 letters).
    solveBrowser: columnar(
      'nobodynoticedthelittledoorbehindthelibraryshelfuntilthenightthestormknockedouteverylightinthevillage' +
        'andtheoldcaretakerfinallytoldthechildrenwhatthekeywasforflag{key_order_found}',
      'STRANGE',
    ),
    // Self-made: 6 x 6 grid read as a clockwise spiral from the top left.
    spiral: spiralEncrypt('readthisfirstflag{spiral_route_ok}go', 6),
  };
  for (const [name, value] of Object.entries(samples)) console.log(`${name}: ${value}`);
}
