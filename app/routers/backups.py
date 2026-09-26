"""Native VM backup endpoints. The actual logic (qemu-img, transient
external snapshot, scheduling) lives in app/core/backups.py; this file only
validates input, checks permissions and orchestrates the background task."""

import logging
import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.audit import log_action
from app.core.backups import (
    DEFAULT_BACKUP_DIR,
    _next_run,
    restore_backup,
    run_backup,
)
from app.core.database import get_conn
from app.core.security import get_current_user, require_role, require_vm_privilege

logger = logging.getLogger(__name__)

router = APIRouter(tags=["backups"])


@router.get("/backups")
def list_all_backups(user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM backups ORDER BY cree_le DESC LIMIT 500").fetchall()
    return [dict(r) for r in rows]


@router.get("/backup-schedules")
def list_backup_schedules(user: dict = Depends(get_current_user)):
    """Every scheduled backup, so a list page can tell which VMs have none."""
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM backup_jobs ORDER BY vm_name").fetchall()
    return [dict(r) for r in rows]


@router.get("/vms/{name}/backups")
def list_vm_backups(name: str, user: dict = Depends(require_vm_privilege("vm.view"))):
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM backups WHERE vm_name = ? ORDER BY cree_le DESC", (name,)).fetchall()
    return [dict(r) for r in rows]


class BackupRequest(BaseModel):
    target_dir: str | None = None


@router.post("/vms/{name}/backups", status_code=202)
def create_backup(name: str, payload: BackupRequest, user: dict = Depends(require_vm_privilege("vm.snapshot"))):
    # Reuses the vm.snapshot privilege (protecting a VM's state, same spirit)
    # rather than introducing yet another dedicated privilege.
    def job():
        try:
            run_backup(name, payload.target_dir, username=user["username"])
        except Exception:
            logger.debug(
                "Ignored exception in job()", exc_info=True
            )  # already logged and tracked in run_backup (task + audit_log)

    threading.Thread(target=job, daemon=True).start()
    log_action(user["username"], "backup_vm_requested", name, "succes")
    return {"message": f"Backup of '{name}' started in the background"}


@router.delete("/backups/{backup_id}")
def delete_backup(backup_id: int, confirm: bool = False, user: dict = Depends(require_role("admin"))):
    import shutil

    with get_conn() as conn:
        row = conn.execute("SELECT * FROM backups WHERE id = ?", (backup_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Backup not found")
        if not confirm:
            raise HTTPException(status_code=400, detail="Add ?confirm=true to confirm the deletion")
        shutil.rmtree(row["chemin"], ignore_errors=True)
        conn.execute("DELETE FROM backups WHERE id = ?", (backup_id,))
        conn.commit()
    log_action(user["username"], "delete_backup", row["vm_name"], "succes", f"backup #{backup_id}")
    return {"message": "Backup deleted"}


class RestoreRequest(BaseModel):
    mode: str = Field(description="'overwrite' (replaces the original VM) or 'new' (new VM)")
    new_name: str | None = None


@router.post("/backups/{backup_id}/restore", status_code=202)
def restore_backup_endpoint(backup_id: int, payload: RestoreRequest, user: dict = Depends(require_role("admin"))):
    with get_conn() as conn:
        row = conn.execute("SELECT vm_name FROM backups WHERE id = ?", (backup_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Backup not found")

    def job():
        try:
            restore_backup(backup_id, payload.mode, payload.new_name, username=user["username"])
        except Exception:
            logger.debug("Ignored exception in job()", exc_info=True)  # already logged in restore_backup

    threading.Thread(target=job, daemon=True).start()
    log_action(user["username"], "restore_backup_requested", row["vm_name"], "succes", f"mode={payload.mode}")
    return {"message": "Restore started in the background"}


class ScheduleRequest(BaseModel):
    frequence: str = Field(description="'quotidien' | 'hebdomadaire' | 'mensuel'")
    heure: str = Field(description="Heure locale UTC au format HH:MM")
    cible_dir: str | None = None
    retention_count: int = Field(7, ge=1, le=365)


@router.get("/vms/{name}/backup-schedule")
def get_backup_schedule(name: str, user: dict = Depends(require_vm_privilege("vm.view"))):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM backup_jobs WHERE vm_name = ?", (name,)).fetchone()
    return dict(row) if row else None


@router.put("/vms/{name}/backup-schedule")
def set_backup_schedule(name: str, payload: ScheduleRequest, user: dict = Depends(require_vm_privilege("vm.snapshot"))):
    if payload.frequence not in ("quotidien", "hebdomadaire", "mensuel"):
        raise HTTPException(status_code=422, detail="Invalid frequency")
    try:
        hh, mm = payload.heure.split(":")
        valid_time = 0 <= int(hh) <= 23 and 0 <= int(mm) <= 59
    except ValueError:
        valid_time = False
    if not valid_time:
        raise HTTPException(status_code=422, detail="Invalid time (expected HH:MM)")

    target = payload.cible_dir or str(DEFAULT_BACKUP_DIR)
    next_run = _next_run(payload.frequence, payload.heure)
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO backup_jobs (vm_name, frequence, heure, cible_dir, retention_count, actif, prochaine_execution) "
            "VALUES (?, ?, ?, ?, ?, 1, ?) "
            "ON CONFLICT(vm_name) DO UPDATE SET frequence=excluded.frequence, heure=excluded.heure, "
            "cible_dir=excluded.cible_dir, retention_count=excluded.retention_count, actif=1, prochaine_execution=excluded.prochaine_execution",
            (name, payload.frequence, payload.heure, target, payload.retention_count, next_run.isoformat()),
        )
        conn.commit()
    log_action(user["username"], "set_backup_schedule", name, "succes", f"{payload.frequence} at {payload.heure}")
    return get_backup_schedule(name, user=user)


@router.delete("/vms/{name}/backup-schedule")
def delete_backup_schedule(name: str, user: dict = Depends(require_vm_privilege("vm.snapshot"))):
    with get_conn() as conn:
        conn.execute("DELETE FROM backup_jobs WHERE vm_name = ?", (name,))
        conn.commit()
    log_action(user["username"], "delete_backup_schedule", name, "succes")
    return {"message": "Schedule deleted"}
