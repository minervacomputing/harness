# Minerva run worker. Built as minerva-worker:<tag> and started by the supervisor's container provider
# with a read-only root filesystem, no capabilities, and no network: only a Unix socket to the gateway.
FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Python for the agent's commands: Debian's interpreter, with the packages of python/requirements.txt in a virtual
# environment, wheels only and every file checked against its hash.
FROM node:24-slim AS python
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY python/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/python \
    && /opt/python/bin/pip install --no-cache-dir --no-deps --only-binary :all: --require-hashes \
       -r /tmp/requirements.txt \
    && /opt/python/bin/pip uninstall -y pip \
    && find /opt/python -name __pycache__ -prune -exec rm -rf {} +

FROM node:24-slim
# The tools the agent's commands may use. Nothing can be installed at run time: the root file system is read-only
# and the worker has no network.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 file jq poppler-utils ripgrep sqlite3 unzip zip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=python /opt/python /opt/python
# Python finds the packages without activating the environment; compiled files cannot be written at run time.
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=512 \
    PATH=/opt/python/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1
RUN python3 -c "import docx, matplotlib, openpyxl, pandas, pdfplumber, PIL, pypdf" \
    && python3 -m compileall -q /opt/python
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER 1000:1000
ENTRYPOINT ["node", "/app/src/main.ts"]
