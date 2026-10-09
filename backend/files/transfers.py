"""Blob transfers in an async view or ASGI app: uploads and downloads whose blocking I/O (temporary files, storage,
and the database work of an upload) runs on threads of their own.

Each transfer holds one of its owner's places (a run's, on the gateway; a user's, on the web) until the I/O it
started has finished: cancelling an await (a client that leaves, a shutdown) does not stop a thread, so giving the
place back earlier would let an owner who keeps leaving occupy every thread.
"""

import asyncio
import contextlib
import functools
import logging
import threading
from collections.abc import Hashable
from concurrent.futures import ThreadPoolExecutor

from django.db import connection

from files import store

CHUNK_BYTES = 256 * 1024

# Transfers never wait behind, or hold up, the views' shared thread or the loop's default pool.
BLOB_IO = ThreadPoolExecutor(max_workers=16, thread_name_prefix="blob-io")
# Places taken per owner, in this process. Only the event loop changes it.
places: dict[Hashable, int] = {}

log = logging.getLogger("minerva.files")


class Busy(Exception):
    pass


class Transfer:
    """One upload or download, holding one of its owner's places in this process.

    Its jobs run on the blob I/O threads. The place is given back only once the transfer has ended and every job
    has finished, then its cleanup. The jobs settle on their threads, so the cleanup does not depend on the loop;
    at shutdown it is best effort. Raises Busy when the owner already has `limit` transfers.
    """

    def __init__(self, owner: Hashable, limit: int) -> None:
        count = places.get(owner, 0)
        if count >= limit:
            raise Busy
        places[owner] = count + 1
        self.owner = owner
        self.loop = asyncio.get_running_loop()
        self.released = self.loop.create_future()
        self.lock = threading.Lock()
        self.running = 0
        self.ended = False
        self.cleanup = None

    async def io(self, fn, *args):
        with self.lock:
            if self.ended:
                raise RuntimeError("The transfer has ended.")
            self.running += 1
        try:
            job = BLOB_IO.submit(fn, *args)
        except BaseException:
            self._settled(None)
            raise
        # Settles on the job's thread when it finishes, or here if it is cancelled before it starts.
        job.add_done_callback(self._settled)
        return await asyncio.wrap_future(job)

    def end(self, cleanup=None) -> None:
        """Ends the transfer, from any thread. `cleanup` runs on a blob I/O thread once every job has finished,
        then the place is given back. Only the first call counts."""
        with self.lock:
            if self.ended:
                return
            self.ended, self.cleanup = True, cleanup
            idle = self.running == 0
        if idle:
            self._close()

    async def finish(self, cleanup=None) -> None:
        """Ends the transfer and waits until its place is given back. Cancelling the wait does not stop that."""
        self.end(cleanup)
        await asyncio.shield(self.released)

    def _settled(self, _job) -> None:
        with self.lock:
            self.running -= 1
            idle = self.ended and self.running == 0
        if idle:
            self._close()

    def _close(self) -> None:
        try:
            BLOB_IO.submit(self._clean_up)
        except RuntimeError:
            # The executor is shutting down.
            self._clean_up()

    def _clean_up(self) -> None:
        try:
            if self.cleanup is not None:
                self.cleanup()
        except Exception:
            log.warning("Blob transfer cleanup failed", exc_info=True)
        finally:
            with contextlib.suppress(RuntimeError):
                # The loop has closed: the process is ending.
                self.loop.call_soon_threadsafe(self._release)

    def _release(self) -> None:
        if places[self.owner] > 1:
            places[self.owner] -= 1
        else:
            del places[self.owner]
        self.released.set_result(None)


def closing_connection(fn):
    """A blob I/O thread's database work: its connection is closed after, since no request cycle does."""

    @functools.wraps(fn)
    def wrapper(*args):
        try:
            return fn(*args)
        finally:
            connection.close()

    return wrapper


class Download:
    """A blob's contents, read chunk by chunk on the blob I/O threads (Django buffers a synchronous iterator
    whole under ASGI). The transfer ends when the iteration does, or when Django closes the response, which it
    does when the client leaves, even if it was never read."""

    def __init__(self, transfer: Transfer) -> None:
        self.transfer = transfer
        self.stream = None

    def open(self, blob) -> None:
        self.stream = store.open_blob(blob)

    async def __aiter__(self):
        try:
            while chunk := await self.transfer.io(self.stream.read, CHUNK_BYTES):
                yield chunk
        finally:
            self.close()

    def close(self) -> None:
        # From any thread; the stream is closed once a read still running has finished.
        self.transfer.end(self._close_stream)

    def _close_stream(self) -> None:
        if self.stream is not None:
            self.stream.close()
