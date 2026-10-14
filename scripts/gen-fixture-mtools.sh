#!/bin/sh
# Builds src/tools/forensics/fixtures/mtools-fat12.img.gz with tools that share no code with
# Find The Flag (mkfs.fat from dosfstools, mtools), so the Binary analyzer's FAT reader is
# checked against an independent writer. The files are synthetic. Needs mkfs.fat, mcopy, mmd,
# mdel, sha256sum and gzip; the output is committed, so CI does not need them.
set -eu
export LC_ALL=C
out="$(cd "$(dirname "$0")/.." && pwd)/src/tools/forensics/fixtures"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
img=mtools-fat12.img
mkfs.fat -C -F 12 -n MTOOLSFAT -i 46544631 "$img" 360 >/dev/null
export MTOOLS_SKIP_CHECK=1 MTOOLS_NO_VFAT=0
# Deterministic content: a counter written as text, and a byte ramp.
i=0; : > notes.txt; while [ $i -lt 300 ]; do echo "line $i of a file written by mtools" >> notes.txt; i=$((i+1)); done
awk 'BEGIN { for (i = 0; i < 6000; i++) printf "%c", (i * 7) % 251 }' > ramp.bin
printf 'short file\n' > SHORT.TXT
printf 'gone, but the clusters stay\n%.0s' $(seq 1 40) > 'Deleted long name.txt'
touch -d '2024-01-15 12:30:00' notes.txt ramp.bin SHORT.TXT 'Deleted long name.txt'
mmd -i "$img" '::/Sub dir with spaces'
mcopy -m -i "$img" notes.txt '::/A long file name, made by mtools.txt'
mcopy -m -i "$img" ramp.bin '::/Sub dir with spaces/ramp data.bin'
mcopy -m -i "$img" SHORT.TXT '::/SHORT.TXT'
mcopy -m -i "$img" 'Deleted long name.txt' '::/Deleted long name.txt'
mdel -i "$img" '::/Deleted long name.txt'
sha() { sha256sum "$1" | cut -d' ' -f1; }
size() { wc -c < "$1" | tr -d ' '; }
cat > "$out/mtools-fat12.json" <<JSON
[
  { "path": "/A long file name, made by mtools.txt", "sha256": "$(sha notes.txt)", "size": $(size notes.txt) },
  { "path": "/Sub dir with spaces/ramp data.bin", "sha256": "$(sha ramp.bin)", "size": $(size ramp.bin) },
  { "path": "/SHORT.TXT", "sha256": "$(sha SHORT.TXT)", "size": $(size SHORT.TXT) },
  { "path": "/Deleted long name.txt", "sha256": "$(sha 'Deleted long name.txt')", "size": $(size 'Deleted long name.txt'), "deleted": true }
]
JSON
gzip -9n -c "$img" > "$out/mtools-fat12.img.gz"
echo "wrote $out/mtools-fat12.img.gz"
