"""Audit log. See _AUDIT_QUEUE below for why writes are asynchronous."""

import contextvars
import queue
import threading
from datetime import UTC, datetime

from app.core.database import get_conn
from app.core.tasks import _finish_task_in

# Design note: log_action() is called by almost every endpoint, even plain
# read-only GETs, so nearly every HTTP request also performs a SQLite write.
# WAL mode resolves reader-versus-writer contention but not writer-versus-writer
# contention (only one writer at a time, even in WAL), so "database is locked"
# can resurface under concurrent requests despite the 30 s timeout.
#
# Instead of writing to SQLite from every calling thread, a single dedicated
# thread owns audit-log writes: callers enqueue the entry (fast, non-blocking,
# no SQLite in the request thread) and return immediately, and the writer thread
# processes entries one at a time. That gives a single writer for the path that
# accounts for most of the application's write volume. Other tables are still
# written directly elsewhere, so this does not remove every possible concurrent
# write, only the most frequent source.
#
# The queue is bounded: in an extreme burst put_nowait() fails rather than
# blocking the calling request forever. The corresponding audit entry is then
# lost (logged to stderr), which is preferable to slowing the application down
# for a secondary log.
_AUDIT_QUEUE = queue.Queue(maxsize=10000)

# Source address of the HTTP request being served, set by a middleware in app/main.py:
# log_action() is called from dozens of endpoints that do not receive the request.
# Background jobs run outside any request and record NULL.
request_ip = contextvars.ContextVar("request_ip", default=None)
_writer_started = False
_writer_lock = threading.Lock()


def _writer_loop():
    while True:
        username, action, resource, result, error_message, ts, ip = _AUDIT_QUEUE.get()
        try:
            with get_conn() as conn:
                conn.execute(
                    "INSERT INTO audit_log (timestamp, username, action, resource, result, error_message, ip) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (ts, username, action, resource, result, error_message, ip),
                )
                conn.commit()
        except Exception as e:
            print(f"[audit] write failed (entry lost): {e!r}", flush=True)
        finally:
            _AUDIT_QUEUE.task_done()


def _ensure_writer_started():
    global _writer_started
    if _writer_started:
        return
    with _writer_lock:
        if not _writer_started:
            threading.Thread(target=_writer_loop, daemon=True, name="audit-writer").start()
            _writer_started = True


def log_action(
    username: str, action: str, resource: str, result: str, error_message: str | None = None, task_id: str | None = None
):
    """task_id: when provided (see app.core.tasks.create_task), the matching task
    is closed too. This stays SYNCHRONOUS (unlike the audit write itself, see
    above) because callers read the task status right after: a task stuck in
    "en_cours" until a queue drains would be a real regression. A
    log_action(..., "succes") or (..., "echec") call already marks the end of
    the task for every current synchronous endpoint."""
    if task_id:
        with get_conn() as conn:
            _finish_task_in(conn, task_id, "termine" if result == "succes" else "echec", error_message)
            conn.commit()

    _ensure_writer_started()
    entry = (username, action, resource, result, error_message, datetime.now(UTC).isoformat(), request_ip.get())
    try:
        _AUDIT_QUEUE.put_nowait(entry)
    except queue.Full:
        print(f"[audit] queue full, entry lost: {entry}", flush=True)

    # Outbound notifications: a single entry point instead of calling notify() at
    # every log_action() call site. It runs in a separate thread rather than in the
    # calling request: notify() performs network I/O (webhook/SMTP, up to 10 s of
    # timeout per channel), and blocking the HTTP response while a remote webhook
    # answers (or times out) would be a robustness problem in itself, independent
    # of SQLite.
    from app.core.notifications import NOTIFY_EVENTS, notify

    if action in NOTIFY_EVENTS:
        title = f"{NOTIFY_EVENTS[action]} — {resource}"
        message = error_message or f"{action} sur '{resource}' : {result}"
        threading.Thread(target=notify, args=(action, title, message, result), daemon=True).start()
