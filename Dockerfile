FROM node:24-slim

# CloakBrowser bundles a stealth-modified Chromium (glibc, not musl — hence
# Debian slim rather than Alpine). These are the shared libs headless Chromium
# needs at runtime; the browser binary itself is downloaded by CloakBrowser
# on first launch and cached in the pod.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libxkbcommon0 libxshmfence1 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2 libatspi2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json ./
RUN npm install --omit=dev

# Prefetch the stealth Chromium binary at build time so pods don't spend
# 30-60s downloading ~200MB on first launch. Pinned to /opt/cloakbrowser
# rather than the default ~/.cloakbrowser so the location is deterministic
# regardless of runtime user (and survives a switch to non-root later).
ENV CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser
# Non-fatal fingerprint quality warning about missing Windows fonts. We accept
# the weaker font fingerprint rather than pull in ~50MB of msttcorefonts.
ENV CLOAKBROWSER_SUPPRESS_FONT_WARNING=1
RUN npx --yes cloakbrowser install

# Application code
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

# Role selected at runtime via APP_ROLE (server | prober | all). Default: all.
CMD ["node", "src/index.js"]
