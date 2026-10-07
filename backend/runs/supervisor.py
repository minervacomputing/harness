"""The supervisor process role: claims queued runs, starts and stops sandboxes, enforces deadlines, and
reconciles runs whose sandbox disappeared. Several supervisors can run at once (claims use SKIP LOCKED).
"""

import contextlib
import logging
import select
import threading
import time
from datetime import timedelta
from uuid import UUID

import psycopg
from django.conf import settings
from django.db import OperationalError, close_old_connections, connections
from django.db.models import Q
from django.utils import timezone

from files import sweep as files_sweep
from minerva.config import config
from runs import services
from runs.models import Run
from runs.sandbox import Limits, SandboxError, provider

log = logging.getLogger("minerva.supervisor")
PROVISIONING_TIMEOUT = timedelta(seconds=90)
POLL_SECONDS = 2.0
ORPHAN_SWEEP_SECONDS = 30.0
FILES_SWEEP_SECONDS = 60.0
ORPHAN_EXITED_GRACE = timedelta(seconds=60)
ORPHAN_RUNNING_GRACE = timedelta(seconds=120)
RECONNECT_MIN_SECONDS = 1.0
RECONNECT_MAX_SECONDS = 30.0


class Supervisor:
    def __init__(self) -> None:
        self.cfg = config()
        self.provider = provider()
        self._last_sweep = 0.0
        self._files_sweep: threading.Thread | None = None
        self._last_files_sweep = 0.0

    def tick(self) -> None:
        close_old_connections()
        self.release_finished()
        self.enforce_deadlines()
        services.sweep_lost_writes()
        self.reconcile()
        self.start_queued()
        if time.monotonic() - self._last_sweep > ORPHAN_SWEEP_SECONDS:
            self._last_sweep = time.monotonic()
            self.collect_orphans()
        self.start_files_sweep()

    def start_files_sweep(self) -> None:
        """Collects unused agent files in a background thread, one sweep at a time, so storage latency never
        delays claims or deadlines."""
        if self._files_sweep is not None and self._files_sweep.is_alive():
            return
        if time.monotonic() - self._last_files_sweep < FILES_SWEEP_SECONDS:
            return
        self._last_files_sweep = time.monotonic()
        self._files_sweep = threading.Thread(target=sweep_files, name="files-sweep", daemon=True)
        self._files_sweep.start()

    def start_queued(self) -> None:
        active = Run.unscoped.filter(status__in=Run.TOKEN_VALID).count()
        capacity = self.cfg.max_concurrent_runs - active
        if capacity <= 0:
            return
        for run, token in services.claim_queued(capacity):
            self._start(run, token)

    def _start(self, run: Run, token: str) -> None:
        """Starts the worker of the run's current attempt."""
        env = {"GATEWAY_URL": self.provider.gateway_url, "RUN_TOKEN": token, "RUN_ID": str(run.id)}
        try:
            handle = self.provider.start(run.id, self.cfg.sandbox_image, env, Limits(), attempt=run.attempt)
        except SandboxError as error:
            # Fail closed: there is no unsandboxed fallback.
            log.error("Sandbox start failed for run %s: %s", run.id, error)
            services.finish(
                run.id,
                Run.Status.FAILED,
                code="sandbox_failed",
                message="The isolated worker could not start.",
                attempt=run.attempt,
            )
            return
        if not Run.unscoped.filter(pk=run.pk, attempt=run.attempt).update(sandbox_handle=handle):
            # Another attempt took over meanwhile; this worker's token is already invalid.
            with contextlib.suppress(SandboxError):
                self.provider.stop(handle)
            return
        log.info("Started run %s (attempt %d) in %s", run.id, run.attempt, self.provider.name)

    def enforce_deadlines(self) -> None:
        now = timezone.now()
        for run_id in Run.unscoped.filter(status__in=Run.TOKEN_VALID, deadline__lte=now).values_list(
            "id", flat=True
        ):
            services.finish(run_id, Run.Status.TIMED_OUT, code="timed_out", message="The run took too long.")
        silent = Run.unscoped.filter(
            status=Run.Status.PROVISIONING, attempt_started_at__lt=now - PROVISIONING_TIMEOUT
        )
        for run_id, attempt in silent.values_list("id", "attempt"):
            services.finish(
                run_id,
                Run.Status.FAILED,
                code="worker_silent",
                message="The worker did not start.",
                attempt=attempt,
                from_status=Run.Status.PROVISIONING,
            )

    def reconcile(self) -> None:
        """A worker that ended without finishing its run (it crashed, or was killed for using too much memory)
        is replaced by a new one that resumes the run from its saved state."""
        for run in Run.unscoped.filter(status__in=Run.TOKEN_VALID, sandbox_handle__isnull=False):
            status = self.provider.status(run.sandbox_handle)
            if status.state not in {"exited", "missing"}:
                continue
            restarted = services.restart(run.id, run.attempt)
            if restarted is services.Restart.WAIT:
                continue
            if restarted is services.Restart.REFUSED:
                log.warning("Worker for run %s ended without a result (%s)", run.id, status)
                services.finish(
                    run.id,
                    Run.Status.FAILED,
                    code="worker_exited",
                    message="The worker stopped unexpectedly.",
                    attempt=run.attempt,
                )
                continue
            log.warning("Worker for run %s ended without a result (%s); restarting it", run.id, status)
            self._start(*restarted)
            try:
                self.provider.stop(run.sandbox_handle)
            except SandboxError:
                # It has exited. Once the run ends, no run tracks it and the orphan sweep removes it.
                log.warning("Could not remove the exited sandbox of run %s", run.id, exc_info=True)

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
        # A finished run without a handle (the database failed right after the start) has nothing
        # left to release it, so only active runs and pending releases count as tracked.
        owned = Q(status__in=Run.ACTIVE) | Q(sandbox_handle__isnull=False, sandbox_released=False)
        tracked = {
            str(run_id) for run_id in Run.unscoped.filter(owned, pk__in=run_ids).values_list("id", flat=True)
        }
        now = timezone.now()
        running_limit = timedelta(seconds=self.cfg.run_time_limit or 0) + ORPHAN_RUNNING_GRACE
        for sandbox in sandboxes:
            if sandbox.run_id in tracked:
                continue
            age = now - sandbox.since
            if age > (running_limit if sandbox.running else ORPHAN_EXITED_GRACE):
                log.info("Removing untracked sandbox for run %s", sandbox.run_id)
                with contextlib.suppress(SandboxError):
                    self.provider.stop(sandbox.handle)


def sweep_files() -> None:
    try:
        removed = files_sweep.sweep()
        if any(removed.values()):
            log.info("Files sweep removed %s", removed)
    except OperationalError:
        log.warning("Files sweep: database unreachable", exc_info=True)
    except Exception:
        log.exception("Files sweep failed")
    finally:
        # The thread's own connections.
        connections.close_all()


def listen_connection() -> psycopg.Connection:
    conn = psycopg.connect(settings.DIRECT_DATABASE_URL, autocommit=True, connect_timeout=10)
    conn.execute(f"LISTEN {services.QUEUED_CHANNEL}")
    return conn


class QueueListener:
    """Wakes the supervisor early when a run is queued.

    Notifications only shorten the wait; polling alone is correct. So while the database is unreachable
    the supervisor keeps polling, and the LISTEN connection is re-established with backoff.
    """

    def __init__(self, connect=listen_connection) -> None:
        self._connect = connect
        self.conn: psycopg.Connection | None = None
        self.backoff = RECONNECT_MIN_SECONDS
        self._retry_at = 0.0

    def wait(self, timeout: float) -> None:
        conn = self.conn or self._reconnect()
        if conn is None:
            time.sleep(timeout)
            return
        try:
            ready, _, _ = select.select([conn.fileno()], [], [], timeout)
            if ready:
                for _ in conn.notifies(timeout=0):
                    pass
                time.sleep(0.05)
        except psycopg.Error, OSError, ValueError:
            log.warning("Lost the queue notification connection; falling back to polling")
            self._drop()

    def _reconnect(self) -> psycopg.Connection | None:
        if time.monotonic() < self._retry_at:
            return None
        try:
            self.conn = self._connect()
        except psycopg.Error as error:
            log.warning("Cannot listen for queued runs (%s); retrying in %.0f s", error, self.backoff)
            self._retry_at = time.monotonic() + self.backoff
            self.backoff = min(self.backoff * 2, RECONNECT_MAX_SECONDS)
            return None
        if self.backoff > RECONNECT_MIN_SECONDS:
            log.info("Listening for queued runs again")
        self.backoff = RECONNECT_MIN_SECONDS
        return self.conn

    def _drop(self) -> None:
        if self.conn is not None:
            with contextlib.suppress(Exception):
                self.conn.close()
        self.conn = None


def serve_forever() -> None:
    supervisor = Supervisor()
    log.info("Supervisor started with the %s sandbox provider", supervisor.provider.name)
    listener = QueueListener()
    database_down = False
    while True:
        try:
            supervisor.tick()
            if database_down:
                log.info("Database reachable again")
            database_down = False
        except OperationalError:
            if not database_down:
                log.warning("Database unreachable; the supervisor keeps retrying", exc_info=True)
            database_down = True
        except Exception:
            log.exception("Supervisor tick failed")
        listener.wait(POLL_SECONDS)
