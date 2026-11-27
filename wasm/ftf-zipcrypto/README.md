# ftf-zipcrypto

A small WebAssembly module that runs the Biham-Kocher known-plaintext attack on traditional
PKWARE ("ZipCrypto") encryption. Given a contiguous run of known plaintext of one entry's
compressed stream, it recovers the cipher's three internal keys, so a whole archive can be
decrypted without the password. It is used by the "ZipCrypto cracker" tool; all of the ZIP
parsing, the roll-back to the base keys and the decryption live in TypeScript
(`src/tools/forensics/_zipcrypto-attack.ts`), and only the heavy key search is here.

## Algorithm and attribution

The attack follows the algorithm of [bkcrack](https://github.com/kimci86/bkcrack) by
Joachim Hotonnier, which is published under the zlib/libpng License (a permissive licence). The
Rust here is an **original, altered implementation written for Find The Flag** — it is not the
bkcrack software and must not be represented as such. As the zlib licence invites, we gratefully
acknowledge bkcrack for the algorithm (the Z-reduction, the multiplication-table fibers, and the
Y/X recovery).

bkcrack's licence, reproduced as an acknowledgement:

```
The zlib/libpng License — Copyright (c) 2016-2026 Joachim Hotonnier
This software is provided 'as-is', without any express or implied warranty. ...
1. The origin of this software must not be misrepresented; you must not claim that you wrote the
   original software. ...
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being
   the original software.
3. This notice may not be removed or altered from any source distribution.
```

## Rebuilding `pkg/`

Needs the Rust toolchain, the `wasm32-unknown-unknown` target and `wasm-pack`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
cd wasm/ftf-zipcrypto
wasm-pack build --target web --release --out-name ftf_zipcrypto
```

`pkg/` is committed so the site builds without the Rust toolchain. It is generated, so it is
excluded from ESLint and Prettier. Unlike the x86 module, this one is compiled for **speed**
(`opt-level = 3`): the attack is compute-heavy, so a larger `.wasm` is worth the faster search.

The attack's correctness is proven by the crate's own tests: `cargo test` recovers the keys from
random ZipCrypto states and checks that rolling the recovered state back yields the base keys and
that decryption reproduces the plaintext. The slow no-solution path is behind `#[ignore]` (run it
with `cargo test -- --ignored`).

## Licence

- This wrapper crate (`src/lib.rs`): MIT, part of Find The Flag.
- The algorithm is bkcrack's (zlib/libpng, see above).
