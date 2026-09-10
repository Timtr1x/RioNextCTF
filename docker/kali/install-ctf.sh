#!/bin/bash
# CTF toolchain layer: binary/reverse/pwn, misc/forensics/stego, crypto.
# Kept separate from install-extra.sh so the web layer cache is untouched.
# Heavy optional tooling (Ghidra, SageMath, libc-database) is intentionally not
# installed in v1; the 4G/2CPU campaign containers cannot host them well.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

rm -f /etc/apt/sources.list.d/kali.sources
printf '%s\n' 'deb http://kali.download/kali kali-rolling main contrib non-free non-free-firmware' > /etc/apt/sources.list

apt-get update
apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
  binutils elfutils gdb gdbserver checksec strace ltrace patchelf \
  radare2 qemu-user gcc g++ make cmake socat netcat-openbsd libc6-dbg \
  binwalk foremost libimage-exiftool-perl steghide stegseek pngcheck \
  imagemagick ffmpeg zbar-tools tesseract-ocr \
  7zip zip unzip qpdf poppler-utils tshark tcpdump \
  openssl john hashcat pari-gp \
  ruby ruby-dev xxd
apt-get clean
rm -rf /var/lib/apt/lists/*

# Isolated Python environment for CTF libraries. The system python3 stays
# untouched; the model reaches this one through /usr/local/bin/ctf-python.
python3 -m venv /opt/rionext-ctf-venv
/opt/rionext-ctf-venv/bin/pip install --no-cache-dir --upgrade pip
/opt/rionext-ctf-venv/bin/pip install --no-cache-dir \
  pwntools==4.15.0 \
  pycryptodome \
  z3-solver \
  capstone \
  unicorn \
  lief \
  ROPGadget \
  ropper \
  scapy \
  Pillow \
  numpy \
  sympy \
  gmpy2 \
  oletools
# Solver-heavy but wheel-available; required per plan (build fails loudly if a
# wheel disappears for the arch, which is better than a silent gap).
/opt/rionext-ctf-venv/bin/pip install --no-cache-dir angr fpylll

# Stable entry points so nothing depends on venv-internal paths.
ln -sf /opt/rionext-ctf-venv/bin/python /usr/local/bin/ctf-python
ln -sf /opt/rionext-ctf-venv/bin/ROPgadget /usr/local/bin/ROPgadget
ln -sf /opt/rionext-ctf-venv/bin/ropper /usr/local/bin/ropper

gem install --no-document one_gadget zsteg

echo "install-ctf: done"
