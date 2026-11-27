//! Biham-Kocher known-plaintext attack on traditional PKWARE ("ZipCrypto") encryption.
//!
//! This is an original Rust implementation of the attack, following the algorithm of bkcrack
//! (https://github.com/kimci86/bkcrack) by Joachim Hotonnier, which is published under the
//! zlib/libpng license. This is an altered version written for Find The Flag; it is not the
//! original bkcrack software and is not represented as such.
//!
//! The one exported function recovers the cipher's internal state (the three 32-bit keys) from a
//! contiguous run of known plaintext of a compressed stream, so a whole archive can be decrypted
//! without the password. All of the ZIP parsing, the roll-back to the base keys and the
//! decryption live in TypeScript; this module does only the heavy key search.

use wasm_bindgen::prelude::*;

#[inline]
fn msb(x: u32) -> u8 {
    (x >> 24) as u8
}
#[inline]
fn lsb(x: u32) -> u8 {
    x as u8
}

const MULT: u32 = 0x08088405;
const MULT_INV: u32 = 0xd94fa8cd;

/// bits [a, 32) set (a < 32).
const fn mask_hi(a: u32) -> u32 {
    !((1u32 << a) - 1)
}
const MASK_2_32: u32 = mask_hi(2);
const MASK_8_32: u32 = mask_hi(8);
const MASK_10_32: u32 = mask_hi(10);
const MASK_24_32: u32 = mask_hi(24);
const MASK_26_32: u32 = mask_hi(26);
const MAXDIFF_24: u32 = (1u32 << 24) - 1;
const MAXDIFF_26: u32 = (1u32 << 26) - 1;

// --------------------------------------------------------------------------- CRC-32 tables
struct Crc32Tab {
    crctab: [u32; 256],
    crcinvtab: [u32; 256],
}
impl Crc32Tab {
    fn new() -> Self {
        let mut crctab = [0u32; 256];
        let mut crcinvtab = [0u32; 256];
        for b in 0u32..256 {
            let mut crc = b;
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb88320 } else { crc >> 1 };
            }
            crctab[b as usize] = crc;
            crcinvtab[msb(crc) as usize] = (crc << 8) ^ b;
        }
        Crc32Tab { crctab, crcinvtab }
    }
    #[inline]
    fn crc32(&self, pval: u32, b: u8) -> u32 {
        (pval >> 8) ^ self.crctab[(lsb(pval) ^ b) as usize]
    }
    #[inline]
    fn crc32inv(&self, crc: u32, b: u8) -> u32 {
        (crc << 8) ^ self.crcinvtab[msb(crc) as usize] ^ (b as u32)
    }
    /// Yi[24,32) from Zi and Z{i-1}.
    #[inline]
    fn get_yi_24_32(&self, zi: u32, zim1: u32) -> u32 {
        (self.crc32inv(zi, 0) ^ zim1) << 24
    }
    /// Z{i-1}[10,32) from Zi[2,32).
    #[inline]
    fn get_zim1_10_32(&self, zi_2_32: u32) -> u32 {
        self.crc32inv(zi_2_32, 0) & MASK_10_32
    }
}

// --------------------------------------------------------------------------- multiplication fibers
struct MultTab {
    fiber2: [Vec<u8>; 256],
    fiber3: [Vec<u8>; 256],
}
impl MultTab {
    fn new() -> Self {
        let mut fiber2: [Vec<u8>; 256] = std::array::from_fn(|_| Vec::new());
        let mut fiber3: [Vec<u8>; 256] = std::array::from_fn(|_| Vec::new());
        let mut prodinv = 0u32; // x * mult^-1
        for x in 0u32..256 {
            let m = msb(prodinv);
            fiber2[m as usize].push(x as u8);
            fiber2[m.wrapping_add(1) as usize].push(x as u8);
            fiber3[m.wrapping_add(255) as usize].push(x as u8);
            fiber3[m as usize].push(x as u8);
            fiber3[m.wrapping_add(1) as usize].push(x as u8);
            prodinv = prodinv.wrapping_add(MULT_INV);
        }
        MultTab { fiber2, fiber3 }
    }
}

// --------------------------------------------------------------------------- keystream tables
/// The keystream byte of a Zi value depends only on Zi[2,16) (bits 0,1 cancel in (z|2)*(z|3)).
fn keystream_byte_from_2_16(idx14: u32) -> u8 {
    let base = idx14 << 2; // Zi[2,16) placed back
    let t = (base | 2) & 0xffff;
    (((t.wrapping_mul(t ^ 1)) >> 8) & 0xff) as u8
}

struct KeystreamTab {
    /// For each keystream byte and each Zi[10,16) (6 bits), the Zi[2,16) values producing it.
    invfilter: Vec<Vec<Vec<u32>>>, // [256][64] -> list of Zi[2,16)
    invexists: Vec<[bool; 64]>,    // [256][64]
}
impl KeystreamTab {
    fn new() -> Self {
        let mut invfilter: Vec<Vec<Vec<u32>>> = (0..256).map(|_| vec![Vec::new(); 64]).collect();
        let mut invexists: Vec<[bool; 64]> = (0..256).map(|_| [false; 64]).collect();
        for idx14 in 0u32..(1 << 14) {
            let ki = keystream_byte_from_2_16(idx14) as usize;
            let zi_2_16 = idx14 << 2; // bits [2,16)
            let h6 = ((zi_2_16 & 0xffff) >> 10) as usize; // Zi[10,16)
            invfilter[ki][h6].push(zi_2_16);
            invexists[ki][h6] = true;
        }
        KeystreamTab { invfilter, invexists }
    }
    #[inline]
    fn get_zi_2_16(&self, ki: u8, zi_10_16: u32) -> &Vec<u32> {
        &self.invfilter[ki as usize][((zi_10_16 & 0xffff) >> 10) as usize]
    }
    #[inline]
    fn has_zi_2_16(&self, ki: u8, zi_10_16: u32) -> bool {
        self.invexists[ki as usize][((zi_10_16 & 0xffff) >> 10) as usize]
    }
}

struct Tables {
    crc: Crc32Tab,
    mult: MultTab,
    ks: KeystreamTab,
}

// --------------------------------------------------------------------------- the cipher state
#[derive(Clone, Copy)]
struct Keys {
    x: u32,
    y: u32,
    z: u32,
}
impl Keys {
    fn update(&mut self, t: &Tables, p: u8) {
        self.x = t.crc.crc32(self.x, p);
        self.y = (self.y.wrapping_add(lsb(self.x) as u32)).wrapping_mul(MULT).wrapping_add(1);
        self.z = t.crc.crc32(self.z, msb(self.y));
    }
    fn update_backward(&mut self, t: &Tables, c: u8) {
        self.z = t.crc.crc32inv(self.z, msb(self.y));
        self.y = (self.y.wrapping_sub(1)).wrapping_mul(MULT_INV).wrapping_sub(lsb(self.x) as u32);
        self.x = t.crc.crc32inv(self.x, c ^ self.get_k(t));
    }
    #[inline]
    fn get_k(&self, t: &Tables) -> u8 {
        t.ks_byte(self.z)
    }
}
impl Tables {
    #[inline]
    fn ks_byte(&self, z: u32) -> u8 {
        keystream_byte_from_2_16((z & 0xffff) >> 2)
    }
}

const CONTIGUOUS: usize = 8;

// --------------------------------------------------------------------------- Zreduction
struct Zreduction<'a> {
    keystream: &'a [u8],
    index: usize,
    zi_vector: Vec<u32>,
}
impl<'a> Zreduction<'a> {
    fn new(t: &Tables, keystream: &'a [u8]) -> Self {
        let index = keystream.len() - 1;
        let mut zi_vector = Vec::with_capacity(1 << 20);
        for zi_10_32_shifted in 0u32..(1 << 22) {
            if t.ks.has_zi_2_16(keystream[index], zi_10_32_shifted << 10) {
                zi_vector.push(zi_10_32_shifted << 10);
            }
        }
        Zreduction { keystream, index, zi_vector }
    }

    fn reduce(&mut self, t: &Tables) {
        const TRACK_SIZE_THRESHOLD: usize = 1 << 16;
        const WAIT_SIZE_THRESHOLD: usize = 1 << 8;
        let mut tracking = false;
        let mut best_copy: Vec<u32> = Vec::new();
        let mut best_index = self.index;
        let mut best_size = TRACK_SIZE_THRESHOLD;
        let mut waiting = false;
        let mut wait = 0usize;

        let mut next: Vec<u32> = Vec::with_capacity(1 << 20);
        // dedup set over Z{i-1}[10,32) >> 10 (22 bits)
        let mut seen = vec![false; 1 << 22];

        let mut i = self.index;
        while i >= CONTIGUOUS {
            next.clear();
            let mut number_of_zim1_2_32 = 0usize;
            seen.fill(false);
            for &zi_10_32 in &self.zi_vector {
                for &zi_2_16 in t.ks.get_zi_2_16(self.keystream[i], zi_10_32) {
                    let zim1_10_32 = t.crc.get_zim1_10_32(zi_10_32 | zi_2_16);
                    let key = (zim1_10_32 >> 10) as usize;
                    if !seen[key] && t.ks.has_zi_2_16(self.keystream[i - 1], zim1_10_32) {
                        next.push(zim1_10_32);
                        seen[key] = true;
                        number_of_zim1_2_32 += t.ks.get_zi_2_16(self.keystream[i - 1], zim1_10_32).len();
                    }
                }
            }

            if number_of_zim1_2_32 <= best_size {
                tracking = true;
                best_index = i - 1;
                best_size = number_of_zim1_2_32;
                waiting = false;
            } else if tracking {
                if best_index == i {
                    std::mem::swap(&mut best_copy, &mut self.zi_vector);
                    if best_size <= WAIT_SIZE_THRESHOLD {
                        waiting = true;
                        wait = best_size * 4;
                    }
                }
                if waiting {
                    wait -= 1;
                    if wait == 0 {
                        break;
                    }
                }
            }

            std::mem::swap(&mut self.zi_vector, &mut next);
            i -= 1;
        }

        if tracking {
            if best_index != CONTIGUOUS - 1 {
                std::mem::swap(&mut self.zi_vector, &mut best_copy);
            }
            self.index = best_index;
        } else {
            self.index = CONTIGUOUS - 1;
        }
    }

    /// Extend Zi[10,32) values into Zi[2,32) values using the keystream.
    fn generate(&mut self, t: &Tables) {
        let n = self.zi_vector.len();
        for i in 0..n {
            let base = self.zi_vector[i];
            let v = t.ks.get_zi_2_16(self.keystream[self.index], base).clone();
            for j in 1..v.len() {
                self.zi_vector.push(base | v[j]);
            }
            if !v.is_empty() {
                self.zi_vector[i] = base | v[0];
            }
        }
    }
}

// --------------------------------------------------------------------------- the per-candidate attack
struct Attack<'a> {
    t: &'a Tables,
    plaintext: &'a [u8],
    ciphertext: &'a [u8],
    index: usize, // starting index of the used plaintext/keystream
    zlist: [u32; CONTIGUOUS],
    ylist: [u32; CONTIGUOUS],
    xlist: [u32; CONTIGUOUS],
    solution: Option<Keys>,
}
impl<'a> Attack<'a> {
    fn new(t: &'a Tables, plaintext: &'a [u8], ciphertext: &'a [u8], zi_index: usize) -> Self {
        Attack {
            t,
            plaintext,
            ciphertext,
            index: zi_index + 1 - CONTIGUOUS,
            zlist: [0; CONTIGUOUS],
            ylist: [0; CONTIGUOUS],
            xlist: [0; CONTIGUOUS],
            solution: None,
        }
    }

    fn carryout(&mut self, z7_2_32: u32) -> bool {
        self.zlist[7] = z7_2_32;
        self.explore_zlists(7);
        self.solution.is_some()
    }

    fn explore_zlists(&mut self, i: i32) {
        if self.solution.is_some() {
            return;
        }
        if i != 0 {
            let ii = i as usize;
            let t = self.t;
            let zim1_10_32 = t.crc.get_zim1_10_32(self.zlist[ii]);
            let kbyte = self.keystream_at(self.index + ii - 1);
            for &zim1_2_16 in t.ks.get_zi_2_16(kbyte, zim1_10_32) {
                self.zlist[ii - 1] = zim1_10_32 | zim1_2_16;
                self.zlist[ii] &= MASK_2_32;
                self.zlist[ii] |= (self.t.crc.crc32inv(self.zlist[ii], 0) ^ self.zlist[ii - 1]) >> 8;
                if i < 7 {
                    self.ylist[ii + 1] = self.t.crc.get_yi_24_32(self.zlist[ii + 1], self.zlist[ii]);
                }
                self.explore_zlists(i - 1);
                if self.solution.is_some() {
                    return;
                }
            }
        } else {
            // Z-list complete: iterate over possible Y7 values.
            let mut y7_8_24 = 0u32;
            let mut prod = (MULT_INV.wrapping_mul((msb(self.ylist[7]) as u32) << 24)).wrapping_sub(MULT_INV);
            while y7_8_24 < (1 << 24) {
                let target = msb(self.ylist[6]).wrapping_sub(msb(prod));
                for &y7_0_8 in &self.t.mult.fiber3[target as usize] {
                    if prod
                        .wrapping_add(MULT_INV.wrapping_mul(y7_0_8 as u32))
                        .wrapping_sub(self.ylist[6] & MASK_24_32)
                        <= MAXDIFF_24
                    {
                        self.ylist[7] = (y7_0_8 as u32) | y7_8_24 | (self.ylist[7] & MASK_24_32);
                        self.explore_ylists(7);
                        if self.solution.is_some() {
                            return;
                        }
                    }
                }
                y7_8_24 += 1 << 8;
                prod = prod.wrapping_add(MULT_INV << 8);
            }
        }
    }

    fn explore_ylists(&mut self, i: i32) {
        if self.solution.is_some() {
            return;
        }
        if i != 3 {
            let ii = i as usize;
            let t = self.t;
            let fy = (self.ylist[ii].wrapping_sub(1)).wrapping_mul(MULT_INV);
            let ffy = (fy.wrapping_sub(1)).wrapping_mul(MULT_INV);
            let target = msb(ffy.wrapping_sub(self.ylist[ii - 2] & MASK_24_32));
            for &xi_0_8 in &t.mult.fiber2[target as usize] {
                let yim1 = fy.wrapping_sub(xi_0_8 as u32);
                if ffy
                    .wrapping_sub(MULT_INV.wrapping_mul(xi_0_8 as u32))
                    .wrapping_sub(self.ylist[ii - 2] & MASK_24_32)
                    <= MAXDIFF_24
                    && msb(yim1) == msb(self.ylist[ii - 1])
                {
                    self.ylist[ii - 1] = yim1;
                    self.xlist[ii] = xi_0_8 as u32;
                    self.explore_ylists(i - 1);
                    if self.solution.is_some() {
                        return;
                    }
                }
            }
        } else {
            self.test_xlist();
        }
    }

    fn test_xlist(&mut self) {
        // compute X5..X7
        for i in 5..=7 {
            self.xlist[i] = (self.t.crc.crc32(self.xlist[i - 1], self.plaintext[self.index + i - 1])
                & MASK_8_32)
                | (lsb(self.xlist[i]) as u32);
        }
        // compute X3
        let mut x = self.xlist[7];
        for i in (3..=6).rev() {
            x = self.t.crc.crc32inv(x, self.plaintext[self.index + i]);
        }
        // check X3 fits with Y1[26,32)
        let y1_26_32 = self.t.crc.get_yi_24_32(self.zlist[1], self.zlist[0]) & MASK_26_32;
        if ((self.ylist[3].wrapping_sub(1))
            .wrapping_mul(MULT_INV)
            .wrapping_sub(lsb(x) as u32)
            .wrapping_sub(1))
        .wrapping_mul(MULT_INV)
        .wrapping_sub(y1_26_32)
            > MAXDIFF_26
        {
            return;
        }

        // decipher and filter forward with remaining contiguous plaintext
        let mut keys_forward = Keys { x: self.xlist[7], y: self.ylist[7], z: self.zlist[7] };
        keys_forward.update(self.t, self.plaintext[self.index + 7]);
        let mut p = self.index + 8;
        while p < self.plaintext.len() {
            if (self.ciphertext[p] ^ keys_forward.get_k(self.t)) != self.plaintext[p] {
                return;
            }
            keys_forward.update(self.t, self.plaintext[p]);
            p += 1;
        }

        // and backward
        let mut keys_backward = Keys { x, y: self.ylist[3], z: self.zlist[3] };
        let mut q = self.index + 3;
        while q > 0 {
            q -= 1;
            keys_backward.update_backward(self.t, self.ciphertext[q]);
            if (self.ciphertext[q] ^ keys_backward.get_k(self.t)) != self.plaintext[q] {
                return;
            }
        }

        // roll backward to offset 0 of the ciphertext region (the state before plaintext[0])
        // keys_backward is already at offset 0 here (q == 0), so it IS the region-start state.
        self.solution = Some(keys_backward);
    }

    /// keystream byte at absolute position `pos` = plaintext[pos] XOR ciphertext[pos].
    #[inline]
    fn keystream_at(&self, pos: usize) -> u8 {
        self.plaintext[pos] ^ self.ciphertext[pos]
    }
}

/// Recover the cipher state (key0, key1, key2) at the start of the known-plaintext run.
///
/// `plaintext` and `keystream` are a contiguous run (keystream = plaintext XOR ciphertext). Returns
/// the three keys as [key0, key1, key2] = the state immediately before producing keystream[0], or an
/// empty vector when no state is consistent (wrong plaintext, or fewer than 12 bytes).
#[wasm_bindgen]
pub fn recover_keys(plaintext: &[u8], keystream: &[u8]) -> Vec<u32> {
    if plaintext.len() != keystream.len() || plaintext.len() < 12 {
        return Vec::new();
    }
    let tables = Tables { crc: Crc32Tab::new(), mult: MultTab::new(), ks: KeystreamTab::new() };
    let ciphertext: Vec<u8> = plaintext.iter().zip(keystream).map(|(p, k)| p ^ k).collect();

    let mut zred = Zreduction::new(&tables, keystream);
    zred.reduce(&tables);
    zred.generate(&tables);
    let index = zred.index;

    for &z in &zred.zi_vector {
        let mut attack = Attack::new(&tables, plaintext, &ciphertext, index);
        if attack.carryout(z) {
            let k = attack.solution.unwrap();
            return vec![k.x, k.y, k.z];
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    const INIT: Keys = Keys { x: 0x12345678, y: 0x23456789, z: 0x34567890 };

    fn tables() -> Tables {
        Tables { crc: Crc32Tab::new(), mult: MultTab::new(), ks: KeystreamTab::new() }
    }

    fn keys_from_password(t: &Tables, pw: &[u8]) -> Keys {
        let mut k = INIT;
        for &c in pw {
            k.update(t, c);
        }
        k
    }

    // Encrypt bytes that already begin with the 12-byte header, from a base state.
    fn encrypt(t: &Tables, base: Keys, plain: &[u8]) -> Vec<u8> {
        let mut k = base;
        let mut out = vec![0u8; plain.len()];
        for i in 0..plain.len() {
            out[i] = plain[i] ^ k.get_k(t);
            k.update(t, plain[i]);
        }
        out
    }

    // A tiny deterministic PRNG (no std rng dependency).
    fn rng(seed: u32) -> impl FnMut() -> u32 {
        let mut s = seed;
        move || {
            s = s.wrapping_mul(1664525).wrapping_add(1013904223);
            s
        }
    }

    fn check_case(seed: u32, data_len: usize, known_len: usize, known_off: usize) {
        let t = tables();
        let mut r = rng(seed);
        // random password 1..12 chars
        let pwlen = 1 + (r() as usize % 12);
        let pw: Vec<u8> = (0..pwlen).map(|_| (r() & 0xff) as u8).collect();
        let base = keys_from_password(&t, &pw);
        // entry = 12-byte header + data
        let mut whole = vec![0u8; 12 + data_len];
        for b in whole.iter_mut() {
            *b = (r() & 0xff) as u8;
        }
        let cipher = encrypt(&t, base, &whole);

        // known plaintext of the compressed data at offset known_off
        let plain: Vec<u8> = whole[12 + known_off..12 + known_off + known_len].to_vec();
        let ks: Vec<u8> = plain
            .iter()
            .zip(&cipher[12 + known_off..12 + known_off + known_len])
            .map(|(p, c)| p ^ c)
            .collect();

        let out = recover_keys(&plain, &ks);
        assert_eq!(out.len(), 3, "seed {seed}: no keys found");
        let at_run = Keys { x: out[0], y: out[1], z: out[2] };

        // forward from the recovered state reproduces the known keystream
        let mut k = at_run;
        for i in 0..known_len {
            assert_eq!(k.get_k(&t), ks[i], "seed {seed}: keystream mismatch at {i}");
            k.update(&t, plain[i]);
        }

        // roll the recovered state back over the header + prefix to the base keys
        let mut back = at_run;
        for i in (0..12 + known_off).rev() {
            back.update_backward(&t, cipher[i]);
        }
        assert_eq!(back.x, base.x, "seed {seed}: base x mismatch");
        assert_eq!(back.y, base.y, "seed {seed}: base y mismatch");
        assert_eq!(back.z, base.z, "seed {seed}: base z mismatch");
    }

    #[test]
    fn recovers_keys_generous_plaintext() {
        check_case(1, 400, 256, 0);
    }


    #[test]
    #[ignore = "slow: no solution means exhaustive search; run with --ignored"]
    fn wrong_plaintext_is_rejected() {
        let t = tables();
        let base = keys_from_password(&t, b"infected");
        let mut whole = vec![0u8; 12 + 300];
        let mut r = rng(99);
        for b in whole.iter_mut() {
            *b = (r() & 0xff) as u8;
        }
        let cipher = encrypt(&t, base, &whole);
        let mut plain: Vec<u8> = whole[12..12 + 256].to_vec();
        plain[100] ^= 1; // one wrong byte
        let ks: Vec<u8> =
            plain.iter().zip(&cipher[12..12 + 256]).map(|(p, c)| p ^ c).collect();
        let out = recover_keys(&plain, &ks);
        // Either no keys, or keys that do NOT reproduce the (corrupted) run — never a false positive
        // that would decrypt as if correct.
        if out.len() == 3 {
            let k = Keys { x: out[0], y: out[1], z: out[2] };
            let mut kk = k;
            let mut ok = true;
            for i in 0..plain.len() {
                if kk.get_k(&t) != ks[i] {
                    ok = false;
                    break;
                }
                kk.update(&t, plain[i]);
            }
            assert!(!ok, "a wrong plaintext must not yield a fully-consistent state");
        }
    }
}
