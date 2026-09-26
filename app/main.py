import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.core.audit import request_ip
from app.core.backups import start_backup_scheduler
from app.core.cluster import start_node_poller
from app.core.jobs import ensure_lb_job_exists
from app.core.libvirt_utils import open_conn
from app.core.metrics import start_metrics_collector
from app.core.network_firewall import reapply_all as reapply_network_firewalls
from app.core.seed import seed_admin
from app.core.update_check import start_update_check_scheduler
from app.core.vm_cleanup import start_auto_cleanup_scheduler
from app.routers.acl import router as acl_router
from app.routers.audit import router as audit_router
from app.routers.auth import router as auth_router
from app.routers.backups import router as backups_router
from app.routers.containers import router as containers_router
from app.routers.dashboard import router as dashboard_router
from app.routers.groups import router as groups_router
from app.routers.ha import router as ha_router
from app.routers.host import router as host_router
from app.routers.isos import router as isos_router
from app.routers.jobs import router as jobs_router
from app.routers.metrics import router as metrics_router
from app.routers.network import router as network_router
from app.routers.nodes import router as nodes_router
from app.routers.notifications import router as notifications_router
from app.routers.pools import router as pools_router
from app.routers.sso import router as sso_router
from app.routers.storage import router as storage_router
from app.routers.tasks import router as tasks_router
from app.routers.templates import router as templates_router
from app.routers.update import router as update_router
from app.routers.vm_disks import router as vm_disks_router
from app.routers.vm_export import router as vm_export_router
from app.routers.vms import router as vms_router

app = FastAPI(title="Hyperlite API")


@app.middleware("http")
async def remember_client_ip(request: Request, call_next):
    """Makes the caller's address available to log_action() for the audit log. The
    direct peer address, like the login rate limiter: no proxy header is trusted."""
    token = request_ip.set(request.client.host if request.client else None)
    try:
        return await call_next(request)
    finally:
        request_ip.reset(token)


app.include_router(auth_router)
app.include_router(sso_router)
app.include_router(dashboard_router)
app.include_router(vms_router)
app.include_router(storage_router)
app.include_router(network_router)
app.include_router(templates_router)
app.include_router(isos_router)
app.include_router(audit_router)
app.include_router(tasks_router)
app.include_router(groups_router)
app.include_router(pools_router)
app.include_router(acl_router)
app.include_router(host_router)
app.include_router(update_router)
app.include_router(metrics_router)
app.include_router(backups_router)
app.include_router(jobs_router)
app.include_router(nodes_router)
app.include_router(containers_router)
app.include_router(vm_disks_router)
app.include_router(vm_export_router)
app.include_router(ha_router)
app.include_router(notifications_router)

# Web interface (React/Vite, dashboard/), served at the root.
DASHBOARD_DIST = "dashboard/dist"
if os.path.isdir(DASHBOARD_DIST):
    app.mount("/assets", StaticFiles(directory=f"{DASHBOARD_DIST}/assets"), name="dashboard-assets")
    app.mount("/novnc", StaticFiles(directory=f"{DASHBOARD_DIST}/novnc"), name="dashboard-novnc")
    app.mount("/xterm", StaticFiles(directory=f"{DASHBOARD_DIST}/xterm"), name="dashboard-xterm")


@app.get("/favicon.svg", include_in_schema=False)
def serve_favicon():
    # Vite copies dashboard/public/favicon.svg to the ROOT of dist/, not under
    # /assets. Without this explicit route, the SPA catch-all below (serve_ui,
    # which literally matches any path) intercepted /favicon.svg and returned
    # index.html instead of the real file, so the browser tab never showed the icon.
    favicon_path = f"{DASHBOARD_DIST}/favicon.svg"
    if os.path.isfile(favicon_path):
        return FileResponse(favicon_path, media_type="image/svg+xml")
    return JSONResponse(status_code=404, content={"detail": "favicon not found"})


def _running_version():
    """Version of the code that is actually running (the VERSION file shipped with it)."""
    try:
        return (Path(__file__).resolve().parent.parent / "VERSION").read_text().strip() or None
    except OSError:
        return None


@app.get("/health")
def health():
    import platform
    import sys

    import fastapi as _fastapi

    try:
        import uvicorn as _uvicorn

        uvicorn_version = _uvicorn.__version__
    except ImportError:
        uvicorn_version = None

    conn = open_conn()
    try:
        return {
            "status": "ok",
            "hyperlite_version": _running_version(),
            "hypervisor": conn.getType(),
            "hostname": conn.getHostname(),
            "libvirt_version": conn.getLibVersion(),
            # Introspected for real (platform/sys/fastapi/uvicorn) rather than hard-coded
            # strings: the system panel (see NodeSystemTab.jsx) used to show a hard-coded
            # kernel and Python version that never changed when the host did.
            "kernel": platform.release(),
            "python_version": sys.version.split()[0],
            "fastapi_version": _fastapi.__version__,
            "uvicorn_version": uvicorn_version,
        }
    finally:
        conn.close()


# index.html references asset files by their build hash (e.g. index-abc123.js).
# Without an explicit header, a browser may cache index.html itself beyond a
# simple reload and keep requesting an old JS/CSS pair after a new deployment,
# which looks like an already fixed visual bug. "no-cache" forces revalidation on
# every load (it does not mean "never store") without re-downloading anything
# that has not changed on the server.
NO_CACHE_HEADERS = {"Cache-Control": "no-cache"}


@app.get("/", include_in_schema=False)
@app.get("/{path:path}", include_in_schema=False)
def serve_ui(path: str = ""):
    # SPA catch-all: every client-side URL (react-router) returns index.html and
    # routing happens in the browser. It must remain the LAST declared route so it
    # never intercepts the real API/WebSocket routes registered above it (they are
    # tried first).
    dashboard_index = f"{DASHBOARD_DIST}/index.html"
    if os.path.isfile(dashboard_index):
        return FileResponse(dashboard_index, headers=NO_CACHE_HEADERS)
    return JSONResponse(
        status_code=503,
        content={"detail": "The web interface is not built (run npm run build in dashboard/)."},
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    print(f"UNHANDLED ERROR on {request.method} {request.url.path}: {exc!r}", flush=True)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.on_event("startup")
def on_startup():
    pwd = seed_admin()
    if pwd:
        # Never log the password: store it in a root-only file and log only where it is.
        pw_file = Path(__file__).resolve().parent.parent / "data" / "initial-admin-password.txt"
        pw_file.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(pw_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(pwd + "\n")
        print(f"=== Admin account created: the initial password is in {pw_file} ===", flush=True)
    start_metrics_collector()
    start_backup_scheduler()
    ensure_lb_job_exists()
    start_node_poller()
    start_auto_cleanup_scheduler()
    start_update_check_scheduler()

    # The iptables rules of the network firewall do not survive a host reboot
    # (unlike the per-VM firewall's nwfilter, which libvirt itself manages):
    # reapply everything persisted in the database each time the service starts.
    conn = open_conn()
    try:
        reapply_network_firewalls(conn)
    finally:
        conn.close()
