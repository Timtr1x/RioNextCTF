#!/bin/bash
# CTF toolchain layer: binary/reverse/pwn, misc/forensics/stego, crypto.
# Kept separate from install-extra.sh so the web layer cache is untouched.
# Heavy optional tooling (Ghidra, SageMath, libc-database) is intentionally not
# installed in v1; the 4G/2CPU campaign containers cannot host them well.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

rm -f /etc/apt/sources.list.d/kali.sources
printf '%s\n' 'deb http://kali.download/kali kali-rolling main contrib non-free non-free-firmware' > /etc/apt/sources.list

# apt goes direct first: kali.download is a fast CDN without a proxy. But both
# direct Cloudflare and a build-time proxy env have been observed flapping
# mid-install on long transfers, so: serial queue mode (no parallel bursts),
# generous retries, and a fallback pass through the ambient env (proxy if the
# build provided one) with --fix-missing. apt >= 2.x honors lowercase
# http_proxy env, hence the explicit env -u strip for the direct pass.
APT_DIRECT="env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy"
APT_OPTS="-o Acquire::Retries=5 -o Acquire::Queue-Mode=access -o Acquire::http::Timeout=30"
apt_update() { $APT_DIRECT apt-get $APT_OPTS update || apt-get $APT_OPTS update; }
apt_install() {
  $APT_DIRECT apt-get $APT_OPTS install -y --no-install-recommends "$@" \
    || apt-get $APT_OPTS install -y --fix-missing --no-install-recommends "$@"
}
apt_update
apt_install \
  binutils elfutils gdb gdbserver checksec strace ltrace patchelf \
  radare2 qemu-user gcc g++ make cmake socat netcat-openbsd libc6-dbg \
  pkg-config libglib2.0-dev \
  binwalk foremost libimage-exiftool-perl steghide stegseek pngcheck \
  imagemagick ffmpeg zbar-tools tesseract-ocr \
  7zip zip unzip qpdf poppler-utils tshark tcpdump \
  openssl john hashcat pari-gp \
  ruby ruby-dev xxd bsdextrautils ncat
apt-get clean
rm -rf /var/lib/apt/lists/*

# Isolated Python environment for CTF libraries. The system python3 stays
# untouched; the model reaches this one through /usr/local/bin/ctf-python.
# Network to PyPI (direct and proxied alike) flaps mid-session on this build
# host, so pip gets long timeouts, many in-command retries, and an outer
# 3-attempt loop; --no-cache-dir stays so a corrupted partial page never sticks.
python3 -m venv /opt/rionext-ctf-venv
PIP=/opt/rionext-ctf-venv/bin/pip
pip_retry() {
  i=1
  while [ "$i" -le 3 ]; do
    if $PIP install --no-cache-dir --retries 10 --timeout 60 "$@"; then
      return 0
    fi
    echo "pip attempt $i failed: $*" >&2
    i=$((i + 1))
    sleep $((i * 15))
  done
  return 1
}
$PIP install --no-cache-dir --upgrade pip
pip_retry \
  pwntools==4.15.0 \
  pycryptodome \
  z3-solver \
  capstone \
  unicorn \
  ROPGadget \
  scapy \
  Pillow \
  numpy \
  sympy \
  gmpy2 \
  oletools
# Solver-heavy but wheel-available; required per plan (build fails loudly if a
# wheel disappears for the arch, which is better than a silent gap).
# Dropped on kali's Python 3.14: lief (no cp314 wheels/sdist on PyPI) and
# ropper (dep filebytes uses ast.Str, removed in 3.14). ROPgadget covers ropper;
# readelf/rabin2/patchelf + pwntools' pyelftools cover lief.
# unicorn 2.1.2 is a source build on Python 3.14 (pwntools pins out the wheeled
# 2.1.4); pkg-config + libglib2.0-dev are its cmake configure-time deps.
# fpylll's wheel metadata omits its runtime dep cysignals; install it explicitly
# or `import fpylll` fails at verify time.
pip_retry angr fpylll cysignals

# Stable entry points so nothing depends on venv-internal paths.
# ctf-python must be a wrapper, not a symlink: venv/bin/python is itself a
# symlink to the system python, and resolving the two-link chain loses
# pyvenv.cfg, silently running the system site-packages instead of the venv.
printf '%s\n' '#!/bin/sh' 'exec /opt/rionext-ctf-venv/bin/python "$@"' > /usr/local/bin/ctf-python
chmod 0755 /usr/local/bin/ctf-python
ln -sf /opt/rionext-ctf-venv/bin/ROPgadget /usr/local/bin/ROPgadget

i=1
while [ "$i" -le 3 ]; do
  if gem install --no-document one_gadget zsteg; then
    break
  fi
  echo "gem attempt $i failed" >&2
  i=$((i + 1))
  sleep $((i * 15))
  [ "$i" -le 3 ]
done

echo "install-ctf: done"
