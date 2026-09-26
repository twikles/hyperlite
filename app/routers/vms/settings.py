import logging

import libvirt
from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.audit import log_action
from app.core.error_messages import describe_exception
from app.core.libvirt_utils import (
    open_conn,
)
from app.core.security import require_vm_privilege
from app.core.vm_limits import validate_vm_resources
from app.core.vm_meta import set_vm_os_label
from app.routers.vms._shared import _domain_summary, router

logger = logging.getLogger(__name__)


class VMUpdate(BaseModel):
    # DYNAMIC upper bounds (app/core/vm_limits.py): validated in the endpoint, no
    # longer frozen at 2 vCPU / 2 GB.
    vcpu: int | None = Field(default=None, ge=1)
    memory_mb: int | None = Field(default=None, ge=1)
    # Declared guest OS shown in the UI ("Windows Server 2025"). A label only: it can
    # change while the VM runs and does not touch the libvirt definition.
    os_label: str | None = Field(default=None, min_length=1, max_length=64, pattern=r"^[^\x00-\x1f<>]+$")


@router.patch("/{name}")
def update_vm(name: str, payload: VMUpdate, user: dict = Depends(require_vm_privilege("vm.resize"))):
    if payload.vcpu is None and payload.memory_mb is None and payload.os_label is None:
        raise HTTPException(status_code=422, detail="No change requested (vcpu, memory_mb or os_label required)")
    if payload.vcpu is None and payload.memory_mb is None:
        conn = open_conn()
        try:
            try:
                domain = conn.lookupByName(name)
            except libvirt.libvirtError:
                raise HTTPException(status_code=404, detail=f"VM '{name}' not found") from None
            set_vm_os_label(name, payload.os_label.strip())
            log_action(user["username"], "update_vm", name, "succes", f"OS label: {payload.os_label.strip()}")
            return _domain_summary(domain)
        finally:
            conn.close()
    limit_errors = validate_vm_resources(payload.vcpu, payload.memory_mb)
    if limit_errors:
        raise HTTPException(status_code=422, detail=limit_errors)

    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "update_vm", name, "echec", "VM not found")
            raise HTTPException(status_code=404, detail=f"VM '{name}' not found") from None

        if domain.isActive():
            log_action(user["username"], "update_vm", name, "echec", "VM active")
            raise HTTPException(status_code=409, detail="Stop the VM before changing its resources")

        try:
            if payload.vcpu is not None:
                # The max must be adjusted before (or at the same time as) the current value,
                # otherwise libvirt refuses a "current" value above the old max.
                domain.setVcpusFlags(payload.vcpu, libvirt.VIR_DOMAIN_AFFECT_CONFIG | libvirt.VIR_DOMAIN_VCPU_MAXIMUM)
                domain.setVcpusFlags(payload.vcpu, libvirt.VIR_DOMAIN_AFFECT_CONFIG)
            if payload.memory_mb is not None:
                kib = payload.memory_mb * 1024
                domain.setMemoryFlags(kib, libvirt.VIR_DOMAIN_AFFECT_CONFIG | libvirt.VIR_DOMAIN_MEM_MAXIMUM)
                domain.setMemoryFlags(kib, libvirt.VIR_DOMAIN_AFFECT_CONFIG)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "update_vm", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Resource update error: {msg}") from e

        if payload.os_label is not None:
            set_vm_os_label(name, payload.os_label.strip())
        domain = conn.lookupByName(name)
        result = _domain_summary(domain)
        log_action(user["username"], "update_vm", name, "succes")
        return result
    finally:
        conn.close()


# --- Resource limits and reservations: a simplified equivalent of vSphere
# Resource Pools (reservation/limit/shares), applied through the cgroup
# mechanisms that libvirt exposes directly (schedulerParametersFlags and
# memoryParameters). No manual XML manipulation is needed, unlike the rest of
# this file: these two calls exist as is in the libvirt API.
#
# Deliberate simplifications (to be documented for the user, no over-engineering
# at the level of full vSphere):
# - CPU "shares": RELATIVE priority under real contention for the host core(s)
#   (cgroup cpu.shares, default 1024). It is not an absolute guarantee and has no
#   effect as long as the host is not saturated.
# - CPU "limit": a hard cap in % of one core PER vCPU (cgroup
#   cpu.cfs_quota_us/cfs_period_us through vcpu_quota/vcpu_period). A VM with 2
#   vCPUs and a 50% limit can consume at most the equivalent of 1 full core,
#   never more, even if the host is idle.
# - RAM: NO real "guaranteed reservation" here. libvirt does expose
#   <memtune><min_guarantee> in its XML schema, but that field is only honoured by
#   the Xen hypervisor and is a no-op on QEMU/KVM (checked in the libvirt
#   documentation). The only real RAM reservation on KVM is not to over-allocate
#   the host (check the available RAM before raising memory_mb, already done by
#   update_vm). What IS really applied here: a hard limit separate from the
#   allocated RAM (<memtune><hard_limit>, cgroup memory.limit_in_bytes), useful
#   to cap a qemu process that would drift beyond the RAM allocated to the guest,
#   not to guarantee a minimum.
UNLIMITED_KB = 9007199254740991  # sentinel documented by libvirt for "no limit"
DEFAULT_CPU_SHARES = 1024
CPU_PERIOD_US = 100000  # standard cgroup period (100 ms), consistent with the libvirt default


class ResourceLimits(BaseModel):
    cpu_shares: int = Field(DEFAULT_CPU_SHARES, ge=2, le=262144)
    cpu_limit_pct: int | None = Field(None, ge=1, le=100, description="% of one host core PER vCPU; null = unlimited")
    mem_hard_limit_mb: int | None = Field(
        None, ge=64, description="Hard RAM cap in MB, separate from the allocated RAM; null = unlimited"
    )


def _limits_summary(domain):
    flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
    sched = domain.schedulerParametersFlags(flags)
    mem = domain.memoryParameters(flags)
    nvcpu = domain.info()[3] or 1
    quota = sched.get("vcpu_quota", 0)
    period = sched.get("vcpu_period", 0) or CPU_PERIOD_US
    cpu_limit_pct = None
    if quota and quota > 0:
        cpu_limit_pct = round((quota / period) / nvcpu * 100)
    hard_limit_kb = mem.get("hard_limit", UNLIMITED_KB)
    return {
        # libvirt returns 0 as long as no explicit value was ever set (the effective
        # cgroup default is 1024, not 0).
        "cpu_shares": sched.get("cpu_shares") or DEFAULT_CPU_SHARES,
        "cpu_limit_pct": cpu_limit_pct,
        "mem_hard_limit_mb": None if hard_limit_kb >= UNLIMITED_KB else round(hard_limit_kb / 1024),
    }


@router.get("/{name}/limits")
def get_vm_limits(name: str, user: dict = Depends(require_vm_privilege("vm.resize"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            raise HTTPException(status_code=404, detail=f"VM '{name}' not found") from None
        return _limits_summary(domain)
    finally:
        conn.close()


@router.put("/{name}/limits")
def set_vm_limits(name: str, payload: ResourceLimits, user: dict = Depends(require_vm_privilege("vm.resize"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "set_vm_limits", name, "echec", "VM not found")
            raise HTTPException(status_code=404, detail=f"VM '{name}' not found") from None

        nvcpu = domain.info()[3] or 1
        # libvirt convention: -1 means unlimited
        vcpu_quota = -1 if payload.cpu_limit_pct is None else int(CPU_PERIOD_US * nvcpu * payload.cpu_limit_pct / 100)

        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if domain.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE

        try:
            domain.setSchedulerParametersFlags(
                {"cpu_shares": payload.cpu_shares, "vcpu_period": CPU_PERIOD_US, "vcpu_quota": vcpu_quota},
                flags,
            )
            hard_limit_kb = UNLIMITED_KB if payload.mem_hard_limit_mb is None else payload.mem_hard_limit_mb * 1024
            domain.setMemoryParameters({"hard_limit": hard_limit_kb}, flags)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "set_vm_limits", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Error applying the limits: {msg}") from e

        log_action(user["username"], "set_vm_limits", name, "succes")
        return _limits_summary(domain)
    finally:
        conn.close()
