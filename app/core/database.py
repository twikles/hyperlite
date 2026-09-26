import contextlib
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(os.environ.get("HYPERLITE_DB_PATH") or Path(__file__).resolve().parent.parent.parent / "hyperlite.db")


@contextmanager
def get_conn():
    # timeout=30 (instead of the default 5 s) plus WAL mode: fixes a real
    # `database is locked` seen repeatedly in practice as soon as two concurrent
    # writes overlap, since the service writes continuously (audit, tasks, metrics
    # every 15 s). WAL lets readers continue while a writer is active (unlike the
    # default rollback-journal mode, which locks the whole file). The PRAGMA is a
    # no-op when already applied, so repeating it on every connection costs nothing.
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                hashed_password TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('admin', 'observateur'))
            )
        """)
        # TOTP 2FA: a separate ALTER, because `users` already exists in deployed
        # databases (same reason as vm_provisioning/task_id below). totp_secret stays
        # NULL until 2FA is both configured and confirmed (see app/core/twofa.py): a
        # secret that was generated but never confirmed by a real code must NOT enable
        # 2FA, otherwise a user who never finished the QR code step would be locked out
        # of their own account.
        for ddl in (
            "ALTER TABLE users ADD COLUMN totp_secret TEXT",
            "ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0",
            # SSO: 'local' (Hyperlite password, the historical behaviour) or 'sso'
            # (provisioned automatically by app/core/sso.py, with the local password made
            # unusable and the role re-resolved at every login from the IdP groups).
            # Distinguishing the two is essential to NEVER let an SSO login overwrite an
            # existing local account (see sso.py::provision_user): the local admin must stay
            # a reliable fallback even if the IdP is misconfigured.
            "ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'",
        ):
            with contextlib.suppress(sqlite3.OperationalError):  # column already exists
                conn.execute(ddl)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                username TEXT,
                action TEXT NOT NULL,
                resource TEXT,
                result TEXT NOT NULL,
                error_message TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                cible TEXT,
                node TEXT,
                username TEXT,
                statut TEXT NOT NULL CHECK(statut IN ('en_attente', 'en_cours', 'termine', 'echec')),
                progres INTEGER NOT NULL DEFAULT 0,
                cree_le TEXT NOT NULL,
                debut_le TEXT,
                fin_le TEXT,
                erreur TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_cree_le ON tasks(cree_le)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS metrics_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                tier TEXT NOT NULL CHECK(tier IN ('raw', 'hourly')),
                scope TEXT NOT NULL CHECK(scope IN ('vm', 'host')),
                cible TEXT NOT NULL,
                cpu_pct REAL,
                mem_used_mb REAL,
                mem_total_mb REAL,
                disk_read_bps REAL,
                disk_write_bps REAL,
                net_rx_bps REAL,
                net_tx_bps REAL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_metrics_cible_ts ON metrics_samples(cible, tier, ts)")

        # ---- Native backups ----
        conn.execute("""
            CREATE TABLE IF NOT EXISTS backup_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vm_name TEXT NOT NULL UNIQUE,
                frequence TEXT NOT NULL CHECK(frequence IN ('quotidien', 'hebdomadaire', 'mensuel')),
                heure TEXT NOT NULL,
                cible_dir TEXT NOT NULL,
                retention_count INTEGER NOT NULL DEFAULT 7,
                actif INTEGER NOT NULL DEFAULT 1,
                derniere_execution TEXT,
                prochaine_execution TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS backups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vm_name TEXT NOT NULL,
                job_id INTEGER,
                chemin TEXT NOT NULL,
                taille_octets INTEGER,
                checksum_sha256 TEXT,
                mode TEXT NOT NULL CHECK(mode IN ('chaud', 'froid')),
                cree_le TEXT NOT NULL,
                statut TEXT NOT NULL CHECK(statut IN ('en_cours', 'termine', 'echec')),
                task_id TEXT,
                erreur TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_backups_vm ON backups(vm_name, cree_le)")

        # ---- Automation: job engine ----
        conn.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                description TEXT,
                predefined_key TEXT,
                created_by TEXT,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS job_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL REFERENCES jobs(id),
                ordre INTEGER NOT NULL,
                cible_type TEXT NOT NULL CHECK(cible_type IN ('vm', 'host', 'chaque_cible')),
                cible TEXT,
                commande TEXT NOT NULL,
                condition_type TEXT NOT NULL DEFAULT 'exit_code' CHECK(condition_type IN ('exit_code', 'stdout_contains')),
                condition_valeur TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS job_runs (
                id TEXT PRIMARY KEY,
                job_id INTEGER NOT NULL REFERENCES jobs(id),
                task_id TEXT,
                dry_run INTEGER NOT NULL DEFAULT 0,
                targets TEXT,
                statut TEXT NOT NULL CHECK(statut IN ('en_cours', 'succes', 'echec')),
                started_at TEXT NOT NULL,
                finished_at TEXT,
                resultat TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS job_run_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL REFERENCES job_runs(id),
                step_ordre INTEGER,
                cible TEXT,
                commande TEXT,
                stdout TEXT,
                stderr TEXT,
                exit_code INTEGER,
                reussi INTEGER,
                horodatage TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id, started_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_job_run_logs_run ON job_run_logs(run_id)")

        # ---- Multi-node ----
        conn.execute("""
            CREATE TABLE IF NOT EXISTS nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                hostname TEXT NOT NULL,
                ssh_user TEXT NOT NULL DEFAULT 'root',
                ssh_port INTEGER NOT NULL DEFAULT 22,
                statut TEXT NOT NULL DEFAULT 'inconnu' CHECK(statut IN ('en_ligne', 'hors_ligne', 'inconnu')),
                derniere_verification TEXT,
                added_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS vm_ssh_users (
                vm_name TEXT PRIMARY KEY,
                username TEXT NOT NULL
            )
        """)
        # Tracking of an unattended installation (Kickstart/autoinstall) in progress:
        # created when the VM is created and deleted as soon as the web SSH terminal
        # answers. It only feeds a progress bar on the dashboard (see
        # GET /vms/{name}/provisioning).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS vm_provisioning (
                vm_name TEXT PRIMARY KEY,
                os_family TEXT NOT NULL,
                started_at TEXT NOT NULL
            )
        """)
        # A separate ALTER (not in the CREATE TABLE above): the table already exists on
        # older installations, and CREATE TABLE IF NOT EXISTS does not retroactively add
        # a column to a table that was already created.
        with contextlib.suppress(sqlite3.OperationalError):  # column already exists
            conn.execute("ALTER TABLE vm_provisioning ADD COLUMN task_id TEXT")
        # OS label DECLARED when the VM is created (deduced from the chosen
        # template/ISO, see vms.create_vm). It is not "detected" in the strict sense (no
        # qemu-guest-agent is installed in guest VMs, so libvirt cannot read anything from
        # the inside), but it is reliable because Hyperlite itself started that
        # installation and knows which OS it asked for.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS vm_os_label (
                vm_name TEXT PRIMARY KEY,
                os_label TEXT NOT NULL
            )
        """)

        # ---- Granular permissions (see app/core/permissions.py) ----
        # User groups, VM pools and assignments (ACLs): a scoped role
        # (operator/manager/reader, distinct from the global admin/observer roles) granted
        # to a user OR a group on a specific VM OR pool. Additive only: it never removes
        # rights from the existing global roles.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS group_members (
                group_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                PRIMARY KEY (group_id, username)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pools (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                description TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pool_members (
                pool_id INTEGER NOT NULL,
                vm_name TEXT NOT NULL,
                PRIMARY KEY (pool_id, vm_name)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS acl (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                subject_type TEXT NOT NULL CHECK(subject_type IN ('user','group')),
                subject_id TEXT NOT NULL,
                role TEXT NOT NULL,
                resource_type TEXT NOT NULL CHECK(resource_type IN ('vm','pool','container')),
                resource_id TEXT NOT NULL
            )
        """)
        # Migration: existing databases were created with the old CHECK
        # (resource_type IN ('vm','pool')). CREATE TABLE IF NOT EXISTS above is a no-op on
        # a table that already exists, and SQLite cannot modify an existing CHECK through
        # ALTER TABLE. The table is rebuilt (idempotent: does nothing if already
        # migrated).
        existing_acl_sql = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='acl'").fetchone()
        if existing_acl_sql and "'container'" not in existing_acl_sql["sql"]:
            conn.execute("ALTER TABLE acl RENAME TO acl_pre_container_migration")
            conn.execute("""
                CREATE TABLE acl (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    subject_type TEXT NOT NULL CHECK(subject_type IN ('user','group')),
                    subject_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    resource_type TEXT NOT NULL CHECK(resource_type IN ('vm','pool','container')),
                    resource_id TEXT NOT NULL
                )
            """)
            conn.execute("INSERT INTO acl SELECT * FROM acl_pre_container_migration")
            conn.execute("DROP TABLE acl_pre_container_migration")
        # Custom roles: the same ACL assignments as the predefined roles
        # (reader/operator/manager), but the user chooses the privilege subset (see
        # ALL_PRIVILEGES in app/core/permissions.py). They are identified in acl.role by
        # "custom:<id>".
        conn.execute("""
            CREATE TABLE IF NOT EXISTS custom_roles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                privileges TEXT NOT NULL
            )
        """)
        # LXC containers: a table distinct from vm_ssh_users. Qemu and lxc domains live
        # in separate libvirt namespaces (see open_lxc_conn), so a container and a VM can
        # in theory share the same name with no collision to avoid here.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS container_ssh_users (
                container_name TEXT PRIMARY KEY,
                username TEXT NOT NULL
            )
        """)
        # HA: "protected" VMs. domain_xml is a CACHE refreshed periodically (see
        # app/core/ha.py::sync_protected_vms) WHILE the source node is reachable, the only
        # way to redefine the VM elsewhere if that node really fails (its XML can no longer
        # be requested once it is unreachable). Protection REQUIRES shared storage,
        # checked at activation AND at every resynchronization: without it there is no
        # guarantee that the disk is even readable from another node.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ha_protected_vms (
                vm_name TEXT PRIMARY KEY,
                node TEXT NOT NULL,
                domain_xml TEXT,
                enabled_by TEXT NOT NULL,
                enabled_at TEXT NOT NULL,
                last_synced_at TEXT
            )
        """)
        # Outbound notifications: the JSON config is stored in clear text (including
        # the SMTP password when type='email'), except that the SMTP password is
        # encrypted at rest (see app/core/secrets_crypto.py). Admin-only. `events` is a
        # JSON list of event names to notify on this channel, [] = all (see
        # app/core/notifications.py::NOTIFY_EVENTS for the full list).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS notification_channels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL CHECK(type IN ('webhook', 'email')),
                name TEXT NOT NULL,
                config TEXT NOT NULL,
                events TEXT NOT NULL DEFAULT '[]',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        # API tokens: a credential dedicated to automation (scripts/Terraform), separate
        # from the session JWT (different lifetime and scope: an API token does not
        # expire after 4 h like a session, but can be revoked individually without
        # signing the user out everywhere). ONLY token_hash (SHA-256) is stored, NEVER
        # the plain token: it is shown only ONCE, at creation (see
        # app/core/api_tokens.py), and cannot be recovered afterwards even by an admin
        # with direct access to the database.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS api_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                name TEXT NOT NULL,
                token_hash TEXT UNIQUE NOT NULL,
                created_at TEXT NOT NULL,
                last_used_at TEXT
            )
        """)
        # Network/datacenter firewall: unlike the per-VM firewall (nwfilter, stored and
        # reapplied by libvirt itself), these iptables rules do NOT survive a host
        # reboot. This table is the only persistent source of truth, reapplied when the
        # service starts (see app/core/network_firewall.py::reapply_all).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS network_firewall (
                network_name TEXT PRIMARY KEY,
                default_policy TEXT NOT NULL,
                rules_json TEXT NOT NULL
            )
        """)
        # Automatic deletion of inactive VMs: an opt-in option chosen at creation
        # ("delete if stopped for N days"). last_active_at is reset every time the VM
        # starts (see app/core/vm_meta.py::touch_vm_activity): the counter only runs while
        # the VM is STOPPED. warned_at records a warning that was already sent, so it is
        # not repeated at every hourly scheduler cycle before the real deletion.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS vm_auto_cleanup (
                vm_name TEXT PRIMARY KEY,
                inactive_days INTEGER NOT NULL,
                last_active_at TEXT NOT NULL,
                warned_at TEXT,
                created_at TEXT NOT NULL
            )
        """)
        # Automatic periodic update check (app/core/update_check.py): a SINGLE row
        # (id=1) that remembers the last remote version already notified, so that only
        # ONE notification is sent per available version instead of one per hourly cycle
        # while nobody applies the update.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS update_check_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                last_notified_version TEXT,
                last_checked_at TEXT
            )
        """)
        # OIDC SSO: a SINGLE row (id=1), the same pattern as update_check_state above.
        # client_secret is encrypted at rest (see app/core/secrets_crypto.py). Admin-only.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sso_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                enabled INTEGER NOT NULL DEFAULT 0,
                issuer TEXT NOT NULL DEFAULT '',
                client_id TEXT NOT NULL DEFAULT '',
                client_secret TEXT NOT NULL DEFAULT '',
                redirect_uri TEXT NOT NULL DEFAULT '',
                scope TEXT NOT NULL DEFAULT 'openid profile email groups',
                group_claim TEXT NOT NULL DEFAULT 'groups',
                admin_groups TEXT NOT NULL DEFAULT ''
            )
        """)
        # Deployment profile chosen by the admin: 'auto' = the profile recommended by
        # hardware detection.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS deployment_profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                profil TEXT NOT NULL DEFAULT 'auto'
            )
        """)
        # VM resource allocation policy chosen by the admin (limits / overcommit /
        # free), see app/core/vm_limits.py.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS allocation_policy (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                politique TEXT NOT NULL DEFAULT 'limites'
            )
        """)
        # CSRF/nonce states of the OIDC Authorization Code flow: SINGLE USE (deleted as
        # soon as consumed, see sso.py::consume_state) and short-lived (STATE_TTL_S,
        # purged along the way rather than by a dedicated scheduler for such an ephemeral
        # table).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sso_login_state (
                state TEXT PRIMARY KEY,
                nonce TEXT NOT NULL,
                created_at REAL NOT NULL
            )
        """)
        # Container backups: a deliberately simpler version than `backups` (VMs): no
        # job_id, no scheduling and no hot/cold mode. A container must always be STOPPED
        # to be backed up (a filesystem, not a qcow2 disk that can be copied while
        # running). Manual only for now.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS container_backups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                container_name TEXT NOT NULL,
                chemin TEXT NOT NULL,
                taille_octets INTEGER,
                cree_le TEXT NOT NULL,
                statut TEXT NOT NULL CHECK(statut IN ('en_cours', 'termine', 'echec')),
                task_id TEXT,
                erreur TEXT
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_container_backups_name ON container_backups(container_name, cree_le)"
        )
        # Latest live figures of every node ('local' = this host), refreshed by the
        # metrics collector: the node list and the dashboard read them instead of
        # opening an SSH connection per node on every page load.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS node_live (
                name TEXT PRIMARY KEY,
                ts TEXT NOT NULL,
                joignable INTEGER NOT NULL DEFAULT 1,
                cpu_pct REAL,
                mem_used_mb REAL,
                mem_total_mb REAL,
                uptime_s INTEGER,
                cores INTEGER,
                cpu_model TEXT,
                kernel TEXT,
                os TEXT,
                address TEXT,
                version_hyperviseur INTEGER,
                version_libvirt INTEGER
            )
        """)
        # Storage pool usage over time (same raw/hourly tiers as metrics_samples).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS storage_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                tier TEXT NOT NULL CHECK(tier IN ('raw', 'hourly')),
                node TEXT NOT NULL,
                pool TEXT NOT NULL,
                capacity_b REAL,
                allocation_b REAL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_storage_samples ON storage_samples(node, pool, tier, ts)")
        for ddl in (
            "ALTER TABLE users ADD COLUMN last_login_at TEXT",
            # Source address of the request that produced the audit entry (NULL for
            # background jobs, which have no request).
            "ALTER TABLE audit_log ADD COLUMN ip TEXT",
        ):
            with contextlib.suppress(sqlite3.OperationalError):  # column already exists
                conn.execute(ddl)
        # The local host used to be stored under a machine-specific label; it is now always "local".
        for table in ("ha_protected_vms", "tasks"):
            conn.execute(f"UPDATE {table} SET node = 'local' WHERE node = 'kvm-lab'")  # noqa: S608
        conn.commit()
