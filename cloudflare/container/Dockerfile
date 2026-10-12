# The sandbox image (plan: The sandbox lifecycle; Configuration, minerva-cf-sandbox): one Firecracker VM per
# turn, started by the Sandbox Durable Object (src/sandbox/) with no route out. It holds no agent loop: the
# loop runs in the Conversation Durable Object, and every agent command and file operation arrives as an
# exec, run through the wrapper in src/sandbox/wrapper.ts as uid 1000 with no capabilities, inside the agent
# cgroup the hardening exec creates. The image is today's worker image (worker/Dockerfile) without Node: the
# same Python packages and versions, installed from hashed wheels only and compiled at build time, and the
# same command-line tools, plus what the hardening needs (util-linux's setpriv and mount, coreutils' timeout,
# procps) and tini as PID 1. Built for linux/amd64 by `cf build` (cloudflare.config.ts). Nothing is added at
# run time: the hardening remounts / read-only before any agent command runs.

# Debian bookworm, whose Python is 3.11, the version python/requirements.txt is compiled for. Pinned by the
# digest of its image index (amd64 for the platform, arm64 for local tests).
ARG BASE=docker.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

FROM ${BASE} AS python
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY python/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/python \
    && /opt/python/bin/pip install --no-cache-dir --no-deps --only-binary :all: --require-hashes \
       -r /tmp/requirements.txt \
    && /opt/python/bin/pip uninstall -y pip \
    && find /opt/python -name __pycache__ -prune -exec rm -rf {} +

FROM ${BASE}
# The tools the agent's commands may use (today's), and what the hardening and the wrapper run.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 file jq poppler-utils ripgrep sqlite3 unzip zip \
       bash coreutils procps util-linux mount tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=python /opt/python /opt/python
# Python finds the packages without activating the environment; compiled files cannot be written at run time.
ENV PATH=/opt/python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PYTHONDONTWRITEBYTECODE=1
RUN python3 -c "import docx, matplotlib, openpyxl, pandas, pdfplumber, PIL, pypdf" \
    && python3 -m compileall -q /opt/python
# The agent's user, uid and gid 1000. Its commands' HOME is /tmp/home, made by the hardening; /home/agent is
# its home on the root file system, which only the read-only remount stops it writing (the probe checks it).
# /workspace is the mount point of the folder's tmpfs.
RUN groupadd --gid 1000 agent \
    && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/agent --shell /bin/bash agent \
    && mkdir -p /workspace && chown 1000:1000 /workspace \
    && for tool in setpriv timeout mount mountpoint tini python3 bash; do command -v "$tool" >/dev/null || exit 1; done
# minerva-fs and the probe, root's and read-only once the hardening has run. Python runs them isolated
# (-I -S), so nothing the agent writes changes them.
COPY minerva/ /opt/minerva/
RUN chmod 0755 /opt/minerva && chmod 0644 /opt/minerva/* \
    && /usr/bin/python3 -I -S -c "import ast; [ast.parse(open(f'/opt/minerva/{name}').read()) for name in ('minerva-fs', 'probe')]"
WORKDIR /workspace
# tini reaps orphans, so killed background processes do not stay as zombies. No secret is ever passed to the
# container's environment: a root process can read PID 1's.
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["sleep", "infinity"]
