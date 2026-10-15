#!/usr/bin/env python3
"""Generates the SSTV test recordings of the `sstv` tool, with PySSTV as the independent encoder.

PySSTV (MIT, https://github.com/dnet/pySSTV) is NOT vendored and is not an npm dependency: the
site never uses it, only this script and the tests' sample files do. To regenerate the files:

    python3 -m venv /tmp/sstv-venv && /tmp/sstv-venv/bin/pip install pysstv==0.5.9 pillow
    /tmp/sstv-venv/bin/python scripts/gen-samples-sstv.py

(or any Python 3 where `import pysstv, PIL` works; `PYTHONPATH=<folder with pysstv>` is enough).

What it writes
    public/samples/sstv-<id>.wav       mono, 8-bit unsigned PCM, 8000 Hz, a few rows of a picture
    public/samples/sstv-robot36.mp3    the Robot 36 recording as 22050 Hz mono MP3 (needs ffmpeg with
                                       libmp3lame; skipped when ffmpeg is missing): it exercises the
                                       browser's MP3 decoder in the end-to-end tests
    src/tools/audio/sstv-ref/<id>.png  the exact picture that was encoded (what the tests compare to)

The picture is self-made: colour bars, FTF{SSTV} in big pixels, a grey ramp. The recordings hold
only the first rows of a mode (a transmission cut at that row count), to keep the files small; the
decoder shows the rows it received.

Where PySSTV 0.5.9 is not used as shipped (checked against the Robot / Martin / Scottie / PD
timings of the published specification, and against the independent `sstv` Rust crate, 0.2.0):
    * Scottie S1 / S2 / DX: PySSTV scans each colour 1.5 ms short (136.74 ms instead of 138.24 ms
      for S1) and adds a 1.5 ms gap after every scan. The spec has one 1.5 ms separator before G
      and B and no gap after R; the subclasses below restore the spec timings (428.22 ms lines).
    * Martin M2 and Scottie S2: PySSTV sends 160 columns stretched over the 320-pixel line time;
      the modes are 320 pixels wide (0.2288 / 0.2752 ms per pixel), so WIDTH is set to 320.
    * Robot 72 and PD 50 do not exist in PySSTV. They are written here with PySSTV's own header,
      modulator and PD / colour machinery, following the same specification: those two are NOT
      checked by an encoder somebody else wrote.
PySSTV 8-bit output is signed bytes in an 8-bit WAV (which is unsigned), so the 16-bit output is
converted to 8-bit here.
"""

import array
import random
import shutil
import subprocess
import sys
import tempfile
import wave
from itertools import chain
from pathlib import Path

from PIL import Image
from pysstv import color
from pysstv.color import ColorSSTV
from pysstv.sstv import FREQ_BLACK, FREQ_VIS_START, FREQ_WHITE, byte_to_freq

ROOT = Path(__file__).resolve().parent.parent
WAV_DIR = ROOT / "public" / "samples"
REF_DIR = ROOT / "src" / "tools" / "audio" / "sstv-ref"
RATE = 8000

# ---------------------------------------------------------------------------- the picture

GLYPHS = {
    "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
    "V": ["#...#", "#...#", "#...#", "#...#", ".#.#.", ".#.#.", "..#.."],
    "{": ["...##", "..#..", "..#..", ".#...", "..#..", "..#..", "...##"],
    "}": ["##...", "..#..", "..#..", "...#.", "..#..", "..#..", "##..."],
}
TEXT = "FTF{SSTV}"
BARS = [
    (255, 255, 255),
    (255, 255, 0),
    (0, 255, 255),
    (0, 255, 0),
    (255, 0, 255),
    (255, 0, 0),
    (0, 0, 255),
    (0, 0, 0),
]
BACKGROUND = (16, 24, 64)
INK = (255, 220, 64)


def make_picture(width, rows, scale, bar_rows, ramp_rows):
    """Colour bars on top, FTF{SSTV} in `scale`-pixel dots, a 16-step grey ramp at the bottom."""
    img = Image.new("RGB", (width, rows), BACKGROUND)
    px = img.load()
    for y in range(bar_rows):
        for x in range(width):
            px[x, y] = BARS[x * len(BARS) // width]
    for y in range(rows - ramp_rows, rows):
        for x in range(width):
            g = (x * 16 // width) * 17
            px[x, y] = (g, g, g)
    if scale:
        cols = len(TEXT) * 6 - 1
        left = (width - cols * scale) // 2
        space = rows - bar_rows - ramp_rows
        top = bar_rows + (space - 7 * scale) // 2
        for i, ch in enumerate(TEXT):
            for gy, line in enumerate(GLYPHS[ch]):
                for gx, c in enumerate(line):
                    if c != "#":
                        continue
                    for dy in range(scale):
                        for dx in range(scale):
                            px[left + (i * 6 + gx) * scale + dx, top + gy * scale + dy] = INK
    return img


# ---------------------------------------------------------------------------- the modes


class Robot72(ColorSSTV):
    """Robot 72 (VIS 12): not in PySSTV. Y 138 ms, then R-Y and B-Y at 69 ms (160 pixels each)."""

    VIS_CODE = 0x0C
    WIDTH = 320
    HEIGHT = 240
    SYNC = 9

    def on_init(self):
        self.yuv = self.image.convert("YCbCr").load()

    def encode_line(self, line):
        pixels = [self.yuv[col, line] for col in range(self.WIDTH)]

        def chroma(index):
            for col in range(0, self.WIDTH, 2):
                value = (pixels[col][index] + pixels[col + 1][index]) / 2
                yield byte_to_freq(value), 69 / (self.WIDTH // 2)

        return chain(
            [(FREQ_BLACK, 3)],
            ((byte_to_freq(p[0]), 138 / self.WIDTH) for p in pixels),
            [(FREQ_BLACK, 4.5), (FREQ_VIS_START, 1.5)],
            chroma(2),  # R-Y = Cr
            [(FREQ_WHITE, 4.5), (FREQ_VIS_START, 1.5)],
            chroma(1),  # B-Y = Cb
        )


class Scottie(color.ScottieS1):
    """Spec timing: [1.5 ms] G [1.5 ms] B [sync 9 ms] [1.5 ms] R, no gap after the scans."""

    def after_channel(self, color_):
        return []


class ScottieS1(Scottie):
    SCAN = 138.24


class ScottieS2(Scottie):
    VIS_CODE = 0x38
    WIDTH = 320
    SCAN = 88.064


class ScottieDX(Scottie):
    VIS_CODE = 0x4C
    SCAN = 345.6


class MartinM2(color.MartinM2):
    WIDTH = 320


class PD50(color.PD90):
    VIS_CODE = 0x5D
    PIXEL = 0.286


# (id, class, width, rows, picture scale, bar rows, ramp rows)
SAMPLES = [
    ("robot36", color.Robot36, 320, 32, 3, 4, 3),
    ("robot72", Robot72, 320, 32, 3, 4, 3),
    ("martin-m1", color.MartinM1, 320, 32, 3, 4, 3),
    ("martin-m2", MartinM2, 320, 32, 3, 4, 3),
    ("scottie-s1", ScottieS1, 320, 32, 3, 4, 3),
    ("scottie-s2", ScottieS2, 320, 32, 3, 4, 3),
    ("scottie-dx", ScottieDX, 320, 24, 2, 3, 3),
    ("pd90", color.PD90, 320, 32, 3, 4, 3),
    ("pd120", color.PD120, 640, 48, 5, 4, 3),
    ("pd180", color.PD180, 640, 48, 5, 4, 3),
    # Secondary PD modes: a few rows of bars and ramp only.
    ("pd50", PD50, 320, 12, 0, 6, 6),
    ("pd160", color.PD160, 512, 12, 0, 6, 6),
    ("pd240", color.PD240, 640, 12, 0, 6, 6),
    ("pd290", color.PD290, 800, 12, 0, 6, 6),
]
VOX = {"robot36"}  # a leading VOX tone burst, to prove the header search skips it


def to_8bit(path16, path8):
    """16-bit PCM WAV -> 8-bit unsigned PCM WAV (what the format specifies)."""
    with wave.open(str(path16), "rb") as src:
        assert src.getnchannels() == 1 and src.getsampwidth() == 2
        rate = src.getframerate()
        samples = array.array("h")
        samples.frombytes(src.readframes(src.getnframes()))
    out = bytes(max(0, min(255, ((s + 128) >> 8) + 128)) for s in samples)
    with wave.open(str(path8), "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(1)
        dst.setframerate(rate)
        dst.writeframes(out)


def write_mp3(wav, mp3):
    """Lossy copy of a recording (22050 Hz, 48 kbit/s, bit-exact so the file is reproducible)."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("ffmpeg not found: not writing", mp3.name)
        return
    subprocess.run(
        [ffmpeg, "-loglevel", "error", "-y", "-i", str(wav), "-ar", "22050", "-ac", "1"]
        + ["-codec:a", "libmp3lame", "-b:a", "48k", "-fflags", "+bitexact"]
        + ["-flags:a", "+bitexact", "-id3v2_version", "0", "-write_xing", "0", str(mp3)],
        check=True,
    )
    print(f"{mp3.name}: {mp3.stat().st_size / 1024:.0f} KiB")


def main():
    random.seed(20240229)  # PySSTV dithers with random(): fix it so the files are reproducible
    only = set(sys.argv[1:])
    WAV_DIR.mkdir(parents=True, exist_ok=True)
    REF_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for ident, base, width, rows, scale, bar_rows, ramp_rows in SAMPLES:
            if only and ident not in only:
                continue
            picture = make_picture(width, rows, scale, bar_rows, ramp_rows)
            picture.save(REF_DIR / f"{ident}.png", optimize=True)
            mode = type(base.__name__, (base,), {"WIDTH": width, "HEIGHT": rows})
            encoder = mode(picture, RATE, 16)
            encoder.vox_enabled = ident in VOX
            wide = Path(tmp) / f"{ident}.wav"
            encoder.write_wav(str(wide))
            narrow = WAV_DIR / f"sstv-{ident}.wav"
            to_8bit(wide, narrow)
            print(f"{narrow.name}: {narrow.stat().st_size / 1024:.0f} KiB, VIS 0x{base.VIS_CODE:02x}")
            if ident == "robot36":
                write_mp3(narrow, WAV_DIR / "sstv-robot36.mp3")


if __name__ == "__main__":
    main()
