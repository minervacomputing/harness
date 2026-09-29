"""The supervisor process role: claims queued runs, starts and stops sandboxes, enforces deadlines, and
reconciles runs whose sandbox disappeared. Several supervisors can run at once (claims use SKIP LOCKED).
"""

import contextlib
import logging
import select
import time
from datetime import timedelta
from uuid import UUID

import psycopg
from django.conf import settings
from django.db import close_old_connections
from django.utils import timezone

from minerva.config import config
from runs import services
from runs.models import Run
from runs.sandbox import Limits, SandboxError, provider

log = logging.getLogger("minerva.supervisor")
PROVISIONING_TIMEOUT = timedelta(seconds=90)
POLL_SECONDS = 2.0
ORPHAN_SWEEP_SECONDS = 30.0
ORPHAN_EXITED_GRACE = timedelta(seconds=60)
ORPHAN_RUNNING_GRACE = timedelta(seconds=120)


class Supervisor:
    def __init__(self) -> None:
        self.cfg = config()
        self.provider = provider()
        self._last_sweep = 0.0

    def tick(self) -> None:
        close_old_connections()
        self.release_finished()
        self.enforce_deadlines()
        self.reconcile()
        self.start_queued()
        if time.monotonic() - self._last_sweep > ORPHAN_SWEEP_SECONDS:
            self._last_sweep = time.monotonic()
            self.collect_orphans()

    def start_queued(self) -> None:
        active = Run.unscoped.filter(status__in=Run.TOKEN_VALID).count()
        capacity = self.cfg.max_concurrent_runs - active
        if capacity <= 0:
            return
        for run, token in services.claim_queued(capacity):
            env = {"GATEWAY_URL": self.cfg.sandbox_gateway_url, "RUN_TOKEN": token, "RUN_ID": str(run.id)}
            try:
                handle = self.provider.start(run.id, self.cfg.sandbox_image, env, Limits())
            except SandboxError as error:
                # Fail closed: there is no unsandboxed fallback.
                log.error("Sandbox start failed for run %s: %s", run.id, error)
                services.finish(
                    run.id,
                    Run.Status.FAILED,
                    code="sandbox_failed",
                    message="The isolated worker could not start.",
                )
                continue
            Run.unscoped.filter(pk=run.pk).update(sandbox_handle=handle)
            log.info("Started run %s in %s", run.id, self.provider.name)

    def enforce_deadlines(self) -> None:
        now = timezone.now()
        for run_id in Run.unscoped.filter(status__in=Run.TOKEN_VALID, deadline__lte=now).values_list(
            "id", flat=True
        ):
            services.finish(run_id, Run.Status.TIMED_OUT, code="timed_out", message="The run took too long.")
        # The deadline is set at claim time, so "claimed more than PROVISIONING_TIMEOUT ago" is:
        claimed_before = now + timedelta(seconds=self.cfg.run_timeout_seconds) - PROVISIONING_TIMEOUT
        silent = Run.unscoped.filter(status=Run.Status.PROVISIONING, deadline__lt=claimed_before)
        for run_id in silent.values_list("id", flat=True):
            services.finish(
                run_id, Run.Status.FAILED, code="worker_silent", message="The worker did not start."
            )

    def reconcile(self) -> None:
        for run in Run.unscoped.filter(status__in=Run.TOKEN_VALID, sandbox_handle__isnull=False):
            status = self.provider.status(run.sandbox_handle)
            if status.state in {"exited", "missing"}:
                log.warning("Worker for run %s ended without a result (%s)", run.id, status)
                services.finish(
                    run.id,
                    Run.Status.FAILED,
                    code="worker_exited",
                    message="The worker stopped unexpectedly.",
                )

    def release_finished(self) -> None:
        finished = Run.unscoped.exclude(status__in=Run.ACTIVE).filter(
            sandbox_released=False, sandbox_handle__isnull=False
        )
        for run in finished:
            try:
                self.provider.stop(run.sandbox_handle)
            except SandboxError:
                log.warning("Could not stop the sandbox of run %s; will retry", run.id, exc_info=True)
                continue
            Run.unscoped.filter(pk=run.pk).update(sandbox_released=True)

    def collect_orphans(self) -> None:
        """Remove sandboxes no run tracks, e.g. after their conversation was deleted mid-run. Their token
        is already invalid, so this only reclaims resources; it is never what ends a worker's access."""
        try:
            sandboxes = self.provider.sandboxes()
        except SandboxError:
            log.warning("Could not list sandboxes", exc_info=True)
            return
        run_ids = []
        for sandbox in sandboxes:
            with contextlib.suppress(ValueError):
                run_ids.append(UUID(sandbox.run_id))
        tracked = {
            str(run_id)
            for run_id in Run.unscoped.filter(pk__in=run_ids, sandbox_released=False).values_list(
                "id", flat=True
            )
        }
        now = timezone.now()
        running_limit = timedelta(seconds=self.cfg.run_timeout_seconds) + ORPHAN_RUNNING_GRACE
        for sandbox in sandboxes:
            if sandbox.run_id in tracked:
                continue
            age = now - sandbox.since
            if age > (running_limit if sandbox.running else ORPHAN_EXITED_GRACE):
                log.info("Removing untracked sandbox for run %s", sandbox.run_id)
                with contextlib.suppress(SandboxError):
                    self.provider.stop(sandbox.handle)


def listen_connection() -> psycopg.Connection:
    conn = psycopg.connect(settings.DIRECT_DATABASE_URL, autocommit=True)
    conn.execute(f"LISTEN {services.QUEUED_CHANNEL}")
    return conn


def serve_forever() -> None:
    supervisor = Supervisor()
    log.info("Supervisor started with the %s sandbox provider", supervisor.provider.name)
    conn = listen_connection()
    while True:
        try:
            supervisor.tick()
        except Exception:
            log.exception("Supervisor tick failed")
        ready, _, _ = select.select([conn.fileno()], [], [], POLL_SECONDS)
        if ready:
            for _ in conn.notifies(timeout=0):
                pass
            time.sleep(0.05)
