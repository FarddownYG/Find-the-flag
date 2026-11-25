//! Minimal x86/x86-64 instruction-boundary scanner for Find The Flag.
//!
//! It wraps the iced-x86 decoder (MIT) and returns nothing but the byte length of each decoded
//! instruction, in order. The tool walks those lengths to locate every instruction's opcode; all
//! of the "semantic dual" (direction-bit) detection and extraction lives in TypeScript, where it
//! is easy to extend and test. Using a proven decoder for the boundaries avoids the desync a
//! hand-rolled length decoder would risk.
use iced_x86::{Decoder, DecoderOptions, Instruction};
use wasm_bindgen::prelude::*;

/// Byte length of each instruction decoded linearly from `code` at the given bitness (16/32/64).
/// An undecodable byte yields a length of 1, so the walk always makes progress.
#[wasm_bindgen]
pub fn instruction_lengths(code: &[u8], bitness: u32) -> Vec<u32> {
    let mut decoder = Decoder::new(bitness, code, DecoderOptions::NONE);
    let mut instr = Instruction::default();
    let mut out: Vec<u32> = Vec::with_capacity(code.len() / 3 + 1);
    while decoder.can_decode() {
        decoder.decode_out(&mut instr);
        let len = instr.len();
        out.push(if len == 0 { 1 } else { len as u32 });
    }
    out
}
