# ftf-x86

A tiny WebAssembly module that wraps the [iced-x86](https://github.com/icedland/iced)
decoder (MIT) to return nothing but the byte length of each x86/x86-64 instruction, in
order. The "Instruction encoding" view of the executable analyzer walks those lengths to
locate every opcode; all of the direction-bit ("semantic dual") detection and extraction
lives in TypeScript (`src/tools/forensics/_exe-encoding.ts`), where it is easy to extend
and test.

Using a proven decoder for the instruction boundaries avoids the desync that a hand-rolled
x86 length decoder would risk on the rare, long encodings (VEX/EVEX…).

## Licence

- This wrapper crate (`src/lib.rs`): MIT, part of Find The Flag.
- The compiled `pkg/ftf_x86_bg.wasm` embeds iced-x86: MIT, see `LICENSE-iced-x86.txt`.

## Rebuilding `pkg/`

Needs the Rust toolchain, the `wasm32-unknown-unknown` target and `wasm-pack`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
cd wasm/ftf-x86
wasm-pack build --target web --release --out-name ftf_x86
```

`pkg/` is committed so the site builds without the Rust toolchain. It is generated, so it is
excluded from ESLint and Prettier. `wasm-opt` is disabled (see `Cargo.toml`); the module is
already small (~180 KB) thanks to `opt-level = "z"` and LTO.
