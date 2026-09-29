"""Runs the worker image's conformance probe under the configured container sandbox.

Every check must pass before the sandbox is trusted with real runs. The gateway must be running."""

import json
import secrets
import time
import uuid

from django.core.management.base import BaseCommand, CommandError

from minerva.config import config
from runs.sandbox import Limits, SandboxError, provider
from runs.sandbox.container import ContainerProvider


class Command(BaseCommand):
    help = "Verify that the container sandbox isolates workers as required."

    def handle(self, *args, **options):
        cfg = config()
        sandbox = provider()
        if not isinstance(sandbox, ContainerProvider):
            raise CommandError("The sandbox check applies to the container provider only.")
        run_id = uuid.uuid4()
        env = {
            "GATEWAY_URL": cfg.sandbox_gateway_url,
            "RUN_TOKEN": f"probe-{secrets.token_urlsafe(24)}",
            "RUN_ID": str(run_id),
        }
        try:
            handle = sandbox.start(run_id, cfg.sandbox_image, env, Limits(), command=["/app/src/probe.ts"])
        except SandboxError as error:
            raise CommandError(str(error)) from error
        try:
            deadline = time.monotonic() + 90
            while sandbox.status(handle).state in {"starting", "running"}:
                if time.monotonic() > deadline:
                    raise CommandError("The probe did not finish within 90 seconds.")
                time.sleep(0.5)
            output = sandbox.logs(handle)
        finally:
            sandbox.stop(handle)

        lines = [line for line in output.splitlines() if line.startswith("{")]
        if not lines:
            raise CommandError(f"The probe produced no result:\n{output}")
        checks: dict[str, bool] = json.loads(lines[-1])
        width = max(map(len, checks))
        for name, passed in checks.items():
            style = self.style.SUCCESS if passed else self.style.ERROR
            self.stdout.write(f"{name.ljust(width)}  {style('pass' if passed else 'FAIL')}")
        failed = [name for name, passed in checks.items() if not passed]
        if failed:
            raise CommandError(f"Sandbox checks failed: {', '.join(failed)}")
        self.stdout.write(self.style.SUCCESS(f"All {len(checks)} sandbox checks passed."))
