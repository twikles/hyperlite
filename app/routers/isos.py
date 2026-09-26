import shutil
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

import libvirt
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.core.audit import log_action
from app.core.error_messages import describe_exception
from app.core.libvirt_utils import open_conn
from app.core.safe_paths import safe_child
from app.core.security import get_current_user, require_role
from app.core.tasks import create_task, finish_task
from app.core.vm_builder import validate_name

router = APIRouter(prefix="/isos", tags=["isos"])

ISOS_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "isos"
ISOS_DIR.mkdir(parents=True, exist_ok=True)


def _iso_in_use(conn, iso_path: str) -> bool:
    for domain in conn.listAllDomains():
        try:
            root = ET.fromstring(domain.XMLDesc(0))
        except libvirt.libvirtError:
            continue
        for disk in root.findall(".//devices/disk"):
            if disk.get("device") != "cdrom":
                continue
            source = disk.find("source")
            if source is not None and source.get("file") == iso_path:
                return True
    return False


@router.get("")
def list_isos(user: dict = Depends(get_current_user)):
    result = []
    for p in sorted(ISOS_DIR.glob("*.iso")):
        st = p.stat()
        result.append(
            {
                "nom": p.name,
                "taille_mo": round(st.st_size / (1024 * 1024), 1),
                "ajoutee_le": datetime.fromtimestamp(st.st_mtime, UTC).isoformat(),
                "emplacement": str(ISOS_DIR),
            }
        )
    return result


@router.post("", status_code=201)
async def upload_iso(file: UploadFile = File(...), user: dict = Depends(require_role("admin"))):
    filename = Path(file.filename or "").name
    task_id = create_task("upload_iso", filename, username=user["username"])

    if not filename.lower().endswith(".iso"):
        finish_task(task_id, "echec", "The file must have the .iso extension")
        raise HTTPException(status_code=422, detail="The file must have the .iso extension")
    base_name = filename[:-4]
    try:
        validate_name(base_name)
    except ValueError as exc:
        finish_task(task_id, "echec", str(exc))
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    dest = safe_child(ISOS_DIR, filename)
    try:
        try:
            with open(dest, "wb") as out:
                shutil.copyfileobj(file.file, out)
        finally:
            await file.close()
    except OSError as e:
        # Safety net: without it, a failing write (disk full, permissions...) would
        # leave the task stuck in "en_cours" forever in the task list, never
        # "termine" and never "echec".
        msg = describe_exception(e)
        finish_task(task_id, "echec", msg)
        raise HTTPException(status_code=500, detail=f"Failed to write the ISO: {msg}") from e

    log_action(user["username"], "upload_iso", filename, "succes", task_id=task_id)
    return {"nom": filename, "taille_mo": round(dest.stat().st_size / (1024 * 1024), 1)}


@router.delete("/{filename}")
def delete_iso(filename: str, confirm: bool = False, user: dict = Depends(require_role("admin"))):
    filename = Path(filename).name
    if not filename.lower().endswith(".iso"):
        raise HTTPException(status_code=422, detail="Invalid file name")
    path = safe_child(ISOS_DIR, filename)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"ISO '{filename}' not found")
    if not confirm:
        raise HTTPException(status_code=400, detail="Confirmation required (?confirm=true)")

    conn = open_conn()
    try:
        if _iso_in_use(conn, str(path)):
            raise HTTPException(status_code=409, detail="ISO in use by a VM, eject it first")
    finally:
        conn.close()

    path.unlink()
    log_action(user["username"], "delete_iso", filename, "succes")
    return {"nom": filename, "supprime": True}
