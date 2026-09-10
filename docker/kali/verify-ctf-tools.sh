#!/bin/bash
# Build-time smoke test for the CTF layer. Fails the image build when a
# required command or python module is missing, and writes the tool index the
# runtime and skill headers are allowed to reference.
set -euo pipefail

VENV=/opt/rionext-ctf-venv
missing=0

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "MISSING binary: $1" >&2
    missing=1
  fi
}

# binary / reverse / pwn
for b in file strings readelf objdump nm ldd gdb gdbserver checksec \
         r2 rabin2 rasm2 radiff2 strace ltrace patchelf \
         qemu-x86_64 qemu-i386 qemu-arm qemu-aarch64 \
         gcc g++ make socat nc ROPgadget ropper one_gadget; do
  require_bin "$b"
done
# misc / forensics / stego
for b in binwalk foremost exiftool steghide stegseek zsteg pngcheck \
         identify convert ffmpeg ffprobe zbarimg tesseract \
         7z unzip zipinfo qpdf pdfinfo pdftotext tshark tcpdump capinfos; do
  require_bin "$b"
done
# crypto
for b in openssl john hashcat gp; do
  require_bin "$b"
done
# base utilities the allowlists promise
for b in bash sh python3 xxd od sha256sum md5sum zip tar ctf-python; do
  require_bin "$b"
done

# version smoke for the load-bearing ones
gdb --version >/dev/null
r2 -v >/dev/null
checksec --help >/dev/null 2>&1 || checksec --version >/dev/null
qemu-x86_64 --version >/dev/null
tshark -v >/dev/null
openssl version >/dev/null
python3 -c 'print(1)' >/dev/null

$VENV/bin/python - <<'PY'
import importlib, sys
mods = {
    "binary": ["pwn", "angr", "lief", "capstone", "unicorn", "z3"],
    "misc": ["scapy", "PIL", "oletools"],
    "crypto": ["Crypto", "sympy", "gmpy2", "fpylll"],
}
missing = []
for group, names in mods.items():
    for name in names:
        try:
            importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001 - build gate, report all
            missing.append(f"{group}:{name}: {exc}")
if missing:
    for m in missing:
        print("MISSING python module:", m, file=sys.stderr)
    sys.exit(1)
print("python modules ok")
PY

# Tool index: only what actually exists in this image.
$VENV/bin/python - <<'PY'
import json, shutil
commands = {
    "binary": ["file", "strings", "readelf", "objdump", "nm", "ldd", "gdb", "gdbserver", "checksec",
               "r2", "rabin2", "rasm2", "radiff2", "strace", "ltrace", "patchelf",
               "qemu-x86_64", "qemu-i386", "qemu-arm", "qemu-aarch64", "gcc", "g++", "make", "socat", "nc",
               "ROPgadget", "ropper", "one_gadget", "ctf-python"],
    "misc": ["binwalk", "foremost", "exiftool", "steghide", "stegseek", "zsteg", "pngcheck",
             "identify", "convert", "ffmpeg", "ffprobe", "zbarimg", "tesseract",
             "7z", "unzip", "zipinfo", "qpdf", "pdfinfo", "pdftotext", "tshark", "tcpdump", "capinfos"],
    "crypto": ["openssl", "john", "hashcat", "gp"],
}
python_modules = {
    "binary": ["pwn", "angr", "lief", "capstone", "unicorn", "z3"],
    "misc": ["scapy", "PIL", "oletools"],
    "crypto": ["Crypto", "sympy", "gmpy2", "fpylll"],
}
index = {
    "commands": {group: [b for b in bins if shutil.which(b)] for group, bins in commands.items()},
    "python_modules": python_modules,
}
with open("/opt/rionext/tool-index.json", "w") as fh:
    json.dump(index, fh, indent=2, sort_keys=True)
print("tool-index.json written")
PY

if [ "$missing" -ne 0 ]; then
  echo "verify-ctf-tools: missing binaries" >&2
  exit 1
fi
echo "verify-ctf-tools: ok"
