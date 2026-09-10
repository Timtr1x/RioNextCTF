FROM kalilinux/kali-rolling

LABEL rionext.role=master \
      rionext.component=kali \
      rionext.browser=playwright

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/rionext \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    NODE_VERSION=22.19.0

RUN mkdir -p /home/rionext /opt/rionext /opt/pw-browsers /workspace /var/log \
 && rm -f /etc/apt/sources.list.d/kali.sources \
 && printf '%s\n' 'deb http://kali.download/kali kali-rolling main contrib non-free non-free-firmware' > /etc/apt/sources.list \
 && apt-get update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      ca-certificates \
      curl \
      xz-utils \
      iproute2 \
      iptables \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

COPY pw/package.json /opt/rionext/package.json
COPY pw/pw-daemon.mjs /opt/rionext/pw-daemon.mjs
COPY pw/pw-ctl.mjs /opt/rionext/pw-ctl.mjs
WORKDIR /opt/rionext
RUN npm install --omit=dev \
 && apt-get update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      libasound2t64 \
      libnss3 \
      libnspr4 \
      libatk-bridge2.0-0t64 \
      libatk1.0-0t64 \
      libatspi2.0-0t64 \
      libdrm2 \
      libgbm1 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libpango-1.0-0 \
      libcairo2 \
      fonts-liberation \
      fonts-unifont \
 && npx playwright install chromium \
 && chmod 0755 /opt/rionext/pw-daemon.mjs /opt/rionext/pw-ctl.mjs \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Headless Kali toolset (nmap, curl, sqlmap, gobuster, ...). First build is large; the tagged image is the master.
RUN rm -f /etc/apt/sources.list.d/kali.sources \
 && printf '%s\n' 'deb http://kali.download/kali kali-rolling main contrib non-free non-free-firmware' > /etc/apt/sources.list \
 && apt-get update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends kali-linux-headless \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Extra scanners, tunnels, and offline knowledge bases. Cached independently of headless.
COPY install-extra.sh /tmp/install-extra.sh
RUN chmod 0755 /tmp/install-extra.sh \
 && /tmp/install-extra.sh \
 && rm -f /tmp/install-extra.sh

# CTF toolchain (binary/misc/crypto) with its own cache layer. The build fails
# here when a promised tool is missing; /opt/rionext/tool-index.json records
# what actually exists.
COPY install-ctf.sh /tmp/install-ctf.sh
COPY verify-ctf-tools.sh /tmp/verify-ctf-tools.sh
RUN chmod 0755 /tmp/install-ctf.sh /tmp/verify-ctf-tools.sh \
 && /tmp/install-ctf.sh \
 && /tmp/verify-ctf-tools.sh \
 && rm -f /tmp/install-ctf.sh /tmp/verify-ctf-tools.sh

COPY entrypoint.sh /usr/local/bin/rionext-entrypoint
RUN chmod 0755 /usr/local/bin/rionext-entrypoint

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/rionext-entrypoint"]
CMD ["sleep", "infinity"]
