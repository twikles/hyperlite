"""Installation automatisee depuis un ISO : construit un petit jeu de reponses
que l'installeur detecte tout seul au demarrage pour creer le compte
utilisateur et y installer la cle SSH d'automatisation Hyperlite, exactement
comme le fait deja le cloud-init des VM Debian. Quatre familles couvertes,
chacune avec son propre format et sa propre technique de livraison :

- Kickstart (RHEL et derives Anaconda) : ISO "OEMDRV" attachee comme disque,
  detectee automatiquement, aucun argument de boot necessaire.
- autoinstall/NoCloud (Ubuntu, installeur Subiquity -- live-server ET
  desktop, meme structure /casper/*) : ISO "cidata" attachee comme disque,
  PLUS le mot-cle "autoinstall" sur la ligne de commande noyau pour sauter la
  confirmation manuelle unique ("Continue with autoinstall?") -- voir
  extract_casper_kernel, qui extrait /casper/vmlinuz et /casper/initrd pour
  les demarrer directement via libvirt (<os><kernel>/<initrd>/<cmdline>).
- preseed (Debian-installer -- Kali, qui reutilise l'installeur Debian tel
  quel) : PAS d'ISO de reponses separee. Le preseed.cfg complet est embarque
  directement a la racine de l'initrd (concatenation cpio+gzip), la methode
  officiellement documentee par Debian pour du preseed "des le tout debut du
  boot" -- meme principe que le menu de boot construit pour l'installeur
  Hyperlite Appliance (voir installer/build-iso.sh, qui fait deja cette
  concatenation pour ses 4 cles de langue/clavier precoces). Voir
  build_preseed_initrd.
- apkovl (Alpine, systeme live -- pas d'installeur Anaconda/Subiquity/d-i) :
  ISO contenant un "apkovl" (archive de config native Alpine) attachee comme
  disque. Sans parametre noyau, l'initrd Alpine scanne lui-meme tous les
  peripheriques locaux a la recherche d'un fichier "*.apkovl.tar.gz" -- meme
  principe d'auto-detection par etiquette qu'OEMDRV/cidata. Voir
  build_alpine_seed_iso.

Limite assumee : un ISO non reconnu retombe sur l'installation manuelle
existante (voir vms.create_vm). Windows (Autounattend.xml) n'est PAS couvert
: aucune ISO d'installation Windows valide n'etait disponible au moment
d'ecrire ce module (l'ISO uploadee, un "LOF" -- Languages and Optional
Features -- ne contient ni setup.exe ni sources/boot.wim, ce n'est pas un
media d'installation bootable)."""

import base64
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from passlib.hash import sha512_crypt

from .vm_builder import IMAGES_DIR

KICKSTART_FAMILIES = ("rhel", "centos", "rocky", "almalinux", "alma-", "fedora")
AUTOINSTALL_FAMILIES = ("ubuntu",)
# Distributions basees sur l'installeur Debian (debian-installer/d-i) autres
# que Debian lui-meme -- Kali le reutilise sans modification (meme structure
# /install.amd/vmlinuz+initrd.gz, verifie directement sur l'ISO Kali 2026.2).
PRESEED_FAMILIES = ("kali",)
ALPINE_FAMILIES = ("alpine",)

# Cache des noyaux/initrd casper extraits : une seule extraction par ISO
# (reutilise pour toutes les VM creees depuis le meme fichier), pas une a
# chaque creation de VM. Sous data/ comme le reste des caches/donnees propres
# a Hyperlite (data/isos, data/ssh, data/tls), pas sous le repertoire systeme
# de libvirt.
CASPER_CACHE_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "casper-cache"


def detect_os_family(iso_filename):
    """Retourne 'kickstart', 'autoinstall', 'preseed', 'alpine' ou None (ISO
    non reconnu -> installation manuelle)."""
    name = iso_filename.lower()
    if any(k in name for k in KICKSTART_FAMILIES):
        return "kickstart"
    if any(k in name for k in AUTOINSTALL_FAMILIES):
        return "autoinstall"
    if any(k in name for k in PRESEED_FAMILIES):
        return "preseed"
    if any(k in name for k in ALPINE_FAMILIES):
        return "alpine"
    return None


def _hash_password(password):
    return sha512_crypt.hash(password)


def build_kickstart_iso(vm_name, username, password, ssh_pubkey):
    """ISO labellisee OEMDRV contenant ks.cfg : Anaconda (RHEL/CentOS/Rocky/Alma/
    Fedora) detecte automatiquement un volume OEMDRV au demarrage et l'utilise
    comme source de kickstart, sans aucun argument de boot a fournir. La cle SSH
    est ecrite via %post plutot que la directive `sshkey` (pas supportee sur
    toutes les versions d'Anaconda, %post l'est partout depuis RHEL6)."""
    workdir = Path(tempfile.mkdtemp(prefix="hyperlite-kickstart-"))
    try:
        pwd_hash = _hash_password(password)
        ks = f"""#version=RHEL9
text
reboot
cdrom
lang en_US.UTF-8
keyboard us
timezone Etc/UTC --utc
network --bootproto=dhcp --activate
rootpw --lock

user --name={username} --groups=wheel --password={pwd_hash} --iscrypted

bootloader --location=mbr
zerombr
clearpart --all --initlabel
autopart --type=lvm

%packages --ignoremissing
@core
openssh-server
%end

%post --erroronfail
mkdir -p /home/{username}/.ssh
echo "{ssh_pubkey}" >> /home/{username}/.ssh/authorized_keys
chmod 700 /home/{username}/.ssh
chmod 600 /home/{username}/.ssh/authorized_keys
chown -R {username}:{username} /home/{username}/.ssh
systemctl enable sshd
%end
"""
        ks_path = workdir / "ks.cfg"
        ks_path.write_text(ks)

        iso_path = IMAGES_DIR / f"{vm_name}-oemdrv.iso"
        subprocess.run(
            ["genisoimage", "-o", str(iso_path), "-V", "OEMDRV", "-r", "-J", str(ks_path)],
            check=True, capture_output=True, text=True,
        )
        return iso_path
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _extract_iso_members(iso_path, cache_subdir, members):
    """Extrait des fichiers precis d'un ISO, mis en cache sous
    data/casper-cache/<cache_subdir>/ (reutilise pour toutes les VM creees
    depuis le meme fichier ISO plutot que refait a chaque creation de VM --
    l'extraction lit potentiellement des centaines de Mo depuis un ISO de
    plusieurs Go, pas instantane). `members` : dict {chemin_dans_iso:
    nom_fichier_local}. Retourne {nom_fichier_local: Path}."""
    cache_dir = CASPER_CACHE_DIR / cache_subdir
    result = {local_name: cache_dir / local_name for local_name in members.values()}
    if all(p.exists() for p in result.values()):
        return result

    cache_dir.mkdir(parents=True, exist_ok=True)
    for member, local_name in members.items():
        subprocess.run(
            ["xorriso", "-osirrox", "on", "-indev", str(iso_path), "-extract", member, str(result[local_name])],
            check=True, capture_output=True, text=True,
        )
    return result


def extract_casper_kernel(iso_path):
    """Extrait /casper/vmlinuz et /casper/initrd de l'ISO Ubuntu live-server
    (ou desktop -- meme structure /casper/* verifiee sur l'ISO 26.04 desktop)
    pour les demarrer directement via libvirt (<os><kernel>/<initrd>), en
    ajoutant "autoinstall" sur la ligne de commande -- seul moyen de sauter
    la confirmation manuelle unique de Subiquity ("Continue with
    autoinstall?"), le mot-cle doit etre present des le demarrage du noyau,
    pas seulement dans l'ISO de reponses (voir build_autoinstall_iso).
    Ligne de commande verifiee directement dans le grub.cfg reel de l'ISO
    Ubuntu 26.04 : `linux /casper/vmlinuz  ---` + `initrd /casper/initrd`,
    aucun autre parametre requis.

    Retourne (kernel_path, initrd_path)."""
    files = _extract_iso_members(iso_path, Path(iso_path).stem, {
        "/casper/vmlinuz": "vmlinuz",
        "/casper/initrd": "initrd",
    })
    return files["vmlinuz"], files["initrd"]


def extract_debian_installer_kernel(iso_path):
    """Extrait /install.amd/vmlinuz et /install.amd/initrd.gz (installeur
    texte debian-installer -- verifie directement sur l'ISO Kali 2026.2, qui
    reutilise cet installeur sans modification, meme chemin que le netinst
    Debian standard, voir installer/build-iso.sh). Le noyau n'a besoin
    d'aucune modification par VM (partage, lecture seule) ; seul l'initrd est
    ensuite copie et modifie par VM pour y embarquer le preseed.cfg propre a
    cette installation, voir build_preseed_initrd.

    Retourne (kernel_path, initrd_path) -- initrd_path ici est le fichier
    d'ORIGINE en cache, pas encore modifie."""
    files = _extract_iso_members(iso_path, Path(iso_path).stem, {
        "/install.amd/vmlinuz": "vmlinuz",
        "/install.amd/initrd.gz": "initrd.gz",
    })
    return files["vmlinuz"], files["initrd.gz"]


def build_autoinstall_iso(vm_name, username, password, ssh_pubkey):
    """ISO NoCloud (label cidata, meme outil cloud-localds que le cloud-init
    Debian) contenant un autoinstall.yaml : Subiquity (installeur "live-server"
    d'Ubuntu) detecte cette source toute seule par etiquette de volume. Le mot-cle
    "autoinstall" doit EN PLUS etre present sur la ligne de commande noyau (voir
    extract_casper_kernel) pour sauter la confirmation manuelle unique
    ("Continue with autoinstall?") -- la seule presence de ce fichier ne
    suffit pas a elle seule."""
    workdir = Path(tempfile.mkdtemp(prefix="hyperlite-autoinstall-"))
    try:
        pwd_hash = _hash_password(password)
        user_data = f"""#cloud-config
autoinstall:
  version: 1
  locale: en_US.UTF-8
  keyboard:
    layout: us
  network:
    version: 2
    ethernets:
      any-ethernet:
        match:
          name: "en*"
        dhcp4: true
  ssh:
    install-server: true
    allow-pw: true
  identity:
    hostname: {vm_name}
    username: {username}
    password: "{pwd_hash}"
  user-data:
    disable_root: true
    users:
      - name: {username}
        lock_passwd: false
        sudo: ALL=(ALL) NOPASSWD:ALL
        ssh_authorized_keys:
          - "{ssh_pubkey}"
  storage:
    layout:
      name: direct
"""
        meta_data = f"instance-id: {vm_name}-{uuid.uuid4()}\nlocal-hostname: {vm_name}\n"

        (workdir / "user-data").write_text(user_data)
        (workdir / "meta-data").write_text(meta_data)

        iso_path = IMAGES_DIR / f"{vm_name}-autoinstall.iso"
        subprocess.run(
            ["cloud-localds", str(iso_path), str(workdir / "user-data"), str(workdir / "meta-data")],
            check=True, capture_output=True, text=True,
        )
        return iso_path
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _cpio_gzip_single_file(filename, content_bytes):
    """Construit une archive cpio (format newc) + gzip contenant un seul
    fichier a la racine -- meme technique que installer/build-iso.sh pour
    embarquer un preseed dans un initrd Debian-installer (concatenation de
    plusieurs archives cpio+gzip a la suite : le noyau les deroule dans
    l'ordre, les fichiers de la derniere archive prevalant sur les
    precedents en cas de collision de nom)."""
    workdir = Path(tempfile.mkdtemp(prefix="hyperlite-cpio-"))
    try:
        (workdir / filename).write_bytes(content_bytes)
        result = subprocess.run(
            f"echo {filename} | cpio -o -H newc | gzip -9",
            shell=True, cwd=workdir, check=True, capture_output=True,
        )
        return result.stdout
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _build_preseed_cfg(vm_name, username, password, ssh_pubkey):
    """Preseed Debian-installer minimal pour une VM invitee (disque unique,
    pas de LVM -- inutile sur une VM jetable) : voir installer/preseed.cfg
    pour le preseed de l'appliance Hyperlite elle-meme, dont les cles
    reseau/partitionnement/paquets ci-dessous sont directement inspirees
    (deja validees sur ce projet)."""
    pwd_hash = _hash_password(password)
    # Encode en base64 plutot qu'ecrit directement (voir plus bas, late_command) :
    # le contenu passe par plusieurs couches fragiles (valeur preseed.cfg ->
    # cpio/initrd -> shell BusyBox ash de l'installeur) avant d'atteindre le
    # disque -- aucun caractere special (crochets, astérisques, guillemets)
    # ne survit de maniere fiable a ce trajet (voir le commentaire pres du
    # late_command), alors qu'un texte base64 (alphabet strictement
    # alphanumerique + "+/=") passe sans encombre a chaque etape.
    network_config = "[Match]\nName=en* eth*\n\n[Network]\nDHCP=yes\n"
    network_config_b64 = base64.b64encode(network_config.encode()).decode()
    return f"""d-i debian-installer/language string en
d-i debian-installer/country string US
d-i debian-installer/locale string en_US.UTF-8
d-i keyboard-configuration/xkb-keymap select us

d-i netcfg/choose_interface select auto
d-i netcfg/link_detection_timeout string 10
d-i netcfg/link_wait_timeout string 10
d-i netcfg/dhcp_timeout string 30
d-i netcfg/get_hostname string {vm_name}
d-i netcfg/get_domain string local
d-i netcfg/hostname string {vm_name}
d-i netcfg/wireless_wep string

d-i clock-setup/utc boolean true
d-i time/zone string Etc/UTC
d-i clock-setup/ntp boolean true

d-i apt-setup/cdrom/set-first boolean true
d-i apt-setup/cdrom/set-next boolean false
d-i apt-setup/cdrom/set-failed boolean false
d-i apt-setup/use_mirror boolean false
d-i mirror/http/hostname string deb.debian.org
d-i mirror/http/directory string /debian
d-i mirror/http/proxy string

d-i passwd/root-login boolean false
d-i passwd/make-user boolean true
d-i passwd/user-fullname string {username}
d-i passwd/username string {username}
d-i passwd/user-password-crypted password {pwd_hash}
d-i passwd/user-default-groups string sudo
d-i user-setup/allow-password-weak boolean true
d-i user-setup/encrypt-home boolean false

d-i partman-auto/method string regular
d-i partman-auto/choose_recipe select atomic
d-i partman-md/confirm boolean true
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true

tasksel tasksel/first multiselect standard, ssh-server
d-i pkgsel/include string openssh-server sudo
d-i pkgsel/upgrade select none
popularity-contest popularity-contest/participate boolean false

d-i grub-installer/only_debian boolean true
d-i grub-installer/bootdev string default

d-i finish-install/reboot_in_progress note

# ETEINDRE plutot que redemarrer en fin d'installation : le noyau/initrd de
# CETTE VM sont demarres via un override <kernel>/<initrd> direct (voir
# build_preseed_initrd) plutot que le <boot order> normal du disque -- un
# vrai reboot materiel (comportement par defaut de debian-installer) rebonde
# donc sur ce MEME noyau/initrd d'installeur au lieu du systeme fraichement
# installe sur le disque, reinstallant en boucle depuis le tout debut
# (constate en test reel : deuxieme ecran "Configuring the network with
# DHCP" apres un premier passage jusqu'a l'installation de GRUB). En
# eteignant plutot que redemarrer, create_vm/get_vm_provisioning (voir
# vms.py) detecte l'arret, retire l'override, et redemarre lui-meme le
# domaine -- qui utilise alors le <boot order> normal, sur le disque, pour
# de vrai cette fois.
d-i debian-installer/exit/poweroff boolean true

# systemd-networkd force au late_command (au lieu de compter sur netcfg pour
# persister la config reseau seul) : constate en test reel, le systeme
# fraichement installe redemarrait bien (voir poweroff plus haut) mais
# restait injoignable (ni ping ni SSH, "No route to host") malgre un bail
# DHCP obtenu pendant l'INSTALLATION -- la persistance de la config reseau
# sur la cible n'etait pas fiable ici (ifupdown/NetworkManager selon ce que
# Kali installe par defaut). Meme technique que pour les conteneurs
# (app/core/container_builder.py) : DHCP via systemd-networkd, toujours
# present (fourni par systemd), sans dependre d'un paquet reseau
# supplementaire ni de la detection d'interface de netcfg.
#
# `|| true` explicite apres CHAQUE commande pouvant echouer (pas juste un
# `true` final) : constate en test reel, une premiere version avec
# seulement un `true` en toute fin de chaine s'est retrouvee interrompue en
# plein milieu (retour au menu principal "[!] Debian installer main menu",
# installation jamais terminee) -- `systemctl disable NetworkManager`
# echoue (paquet absent de cette image minimale) et d-i execute apparemment
# ce late_command sous des semantiques `set -e` : la premiere commande en
# echec interrompt tout de suite le reste de la chaine, le `true` final
# n'etant jamais atteint.
#
# Un `echo` PAR LIGNE plutot qu'un unique `printf "...\nName=...\n..."` a
# d'abord ete tente : l'ecriture en une seule commande printf avec des \n
# imbriques causait "sh: syntax error: unterminated quoted string" cote
# installeur (confirme en lisant /var/log/syslog directement via le shell
# de secours de l'installeur, tty2, sur une VM restee bloquee sur l'echec).
# Les `echo` separes n'ont pas suffi non plus : echec plus precoce encore
# ("Failed to process the preconfiguration file... may be corrupt", constate
# au chargement meme du preseed.cfg, pas seulement au late_command) --
# les crochets/asterisques de "[Match]"/"Name=en*" ne survivent
# apparemment pas non plus au trajet complet. Solution robuste : contenu du
# fichier encode en base64 (network_config_b64 plus haut), decode par une
# seule commande -- aucun caractere special dans la valeur preseed.cfg.
d-i preseed/late_command string \\
    in-target mkdir -p /home/{username}/.ssh; \\
    in-target sh -c 'echo "{ssh_pubkey}" >> /home/{username}/.ssh/authorized_keys'; \\
    in-target chown -R {username}:{username} /home/{username}/.ssh; \\
    in-target chmod 700 /home/{username}/.ssh; \\
    in-target chmod 600 /home/{username}/.ssh/authorized_keys; \\
    in-target systemctl enable ssh; \\
    in-target mkdir -p /etc/systemd/network; \\
    in-target sh -c 'echo {network_config_b64} | base64 -d > /etc/systemd/network/99-hyperlite-dhcp.network'; \\
    in-target systemctl enable systemd-networkd || true; \\
    in-target systemctl disable NetworkManager || true
"""


def build_preseed_initrd(vm_name, iso_path, username, password, ssh_pubkey):
    """Debian-installer (Kali) n'a pas d'equivalent "volume attache
    auto-detecte" pour le preseed complet comme OEMDRV/cidata -- la methode
    officiellement documentee par Debian (et deja utilisee par ce projet dans
    installer/build-iso.sh) est d'embarquer preseed.cfg directement A LA
    RACINE de l'initrd : d-i le charge automatiquement des le tout debut,
    sans aucun parametre noyau `preseed/file=` ni `preseed/url=` necessaire.
    Contrairement a kickstart/autoinstall, il n'y a donc pas d'ISO de
    reponses separee -- tout passe par cet initrd modifie, unique par VM (le
    noyau, lui, reste partage/lecture seule, voir
    extract_debian_installer_kernel).

    Retourne (kernel_path, initrd_path_modifie)."""
    kernel_path, base_initrd_path = extract_debian_installer_kernel(iso_path)

    preseed_text = _build_preseed_cfg(vm_name, username, password, ssh_pubkey)
    preseed_cpio_gz = _cpio_gzip_single_file("preseed.cfg", preseed_text.encode())

    vm_initrd_path = IMAGES_DIR / f"{vm_name}-preseed-initrd.gz"
    with open(vm_initrd_path, "wb") as out:
        out.write(base_initrd_path.read_bytes())
        out.write(preseed_cpio_gz)

    return kernel_path, vm_initrd_path


def build_alpine_seed_iso(vm_name, username, password, ssh_pubkey):
    """Alpine (systeme live, pas d'installeur Anaconda/Subiquity/d-i) n'a pas
    de format kickstart/preseed/autoinstall : l'automatisation passe par un
    "apkovl" (archive de configuration systeme, format natif Alpine -- voir
    `lbu`) charge au demarrage. Sans parametre noyau `apkovl=`, l'initrd
    Alpine (nlplug-findfs) scanne lui-meme tous les peripheriques locaux a la
    recherche d'un fichier "*.apkovl.tar.gz" -- meme principe d'auto-detection
    par etiquette qu'OEMDRV (kickstart) ou cidata (autoinstall), donc pas de
    <cmdline> a fournir non plus (voir create_vm).

    L'apkovl contient un script /etc/local.d demarre automatiquement au boot
    (service OpenRC "local", qu'on active nous-memes dans l'apkovl -- pas
    actif par defaut sur le live). Ce script pilote `setup-disk` DIRECTEMENT
    plutot que le wrapper `setup-alpine` : ce dernier demande le mot de passe
    root en interactif sans option non-interactive pour le pre-fournir
    (limite connue et documentee du projet Alpine). Une fois `setup-disk`
    termine (systeme installe et monte sous /mnt), le script chroot pour
    injecter mot de passe/compte/cle SSH d'automatisation, exactement comme
    le %post du kickstart RHEL ou le late_command Debian."""
    workdir = Path(tempfile.mkdtemp(prefix="hyperlite-alpine-"))
    try:
        pwd_hash = _hash_password(password)
        start_script = f"""#!/bin/sh
set -e
MARKER=/root/.hyperlite-provisioned
[ -f "$MARKER" ] && exit 0

setup-hostname -n {vm_name} >/dev/null 2>&1 || true

cat > /etc/network/interfaces <<'NET'
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
NET
rc-service networking restart >/dev/null 2>&1 || ifup eth0 >/dev/null 2>&1 || true
udhcpc -i eth0 >/dev/null 2>&1 || true

setup-timezone -z UTC >/dev/null 2>&1 || true
setup-apkrepos -1
setup-sshd -c openssh

export ERASE_DISKS="/dev/sda"
echo y | setup-disk -m sys /dev/sda

ROOT=/mnt
echo "root:{pwd_hash}" | chroot "$ROOT" chpasswd -e
chroot "$ROOT" adduser -D -s /bin/ash {username}
echo "{username}:{pwd_hash}" | chroot "$ROOT" chpasswd -e
chroot "$ROOT" apk add --no-cache sudo
chroot "$ROOT" addgroup {username} wheel 2>/dev/null || true
echo '%wheel ALL=(ALL) NOPASSWD: ALL' >> "$ROOT/etc/sudoers"
mkdir -p "$ROOT/home/{username}/.ssh"
echo "{ssh_pubkey}" > "$ROOT/home/{username}/.ssh/authorized_keys"
chroot "$ROOT" chown -R {username}:{username} "/home/{username}/.ssh"
chroot "$ROOT" chmod 700 "/home/{username}/.ssh"
chroot "$ROOT" chmod 600 "/home/{username}/.ssh/authorized_keys"
chroot "$ROOT" rc-update add sshd default

touch "$ROOT$MARKER"
sync
reboot
"""
        apkovl_dir = workdir / "apkovl"
        local_d = apkovl_dir / "etc" / "local.d"
        local_d.mkdir(parents=True)
        (local_d / "hyperlite.start").write_text(start_script)
        (local_d / "hyperlite.start").chmod(0o755)

        runlevels_dir = apkovl_dir / "etc" / "runlevels" / "default"
        runlevels_dir.mkdir(parents=True)
        (runlevels_dir / "local").symlink_to("/etc/init.d/local")

        apkovl_path = workdir / f"{vm_name}.apkovl.tar.gz"
        subprocess.run(
            ["tar", "-czf", str(apkovl_path), "-C", str(apkovl_dir), "etc"],
            check=True, capture_output=True, text=True,
        )

        iso_path = IMAGES_DIR / f"{vm_name}-alpine-seed.iso"
        subprocess.run(
            ["genisoimage", "-o", str(iso_path), "-V", "HYPERLITE", "-r", "-J", str(apkovl_path)],
            check=True, capture_output=True, text=True,
        )
        return iso_path
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def build_seed_iso(os_family, vm_name, username, password, ssh_pubkey):
    """Ne couvre PAS 'preseed' (Kali) : cette famille n'a pas d'ISO de
    reponses separee, voir build_preseed_initrd, appele directement depuis
    vms.create_vm avec l'ISO d'installation elle-meme (necessaire pour en
    extraire le noyau/initrd)."""
    if os_family == "kickstart":
        return build_kickstart_iso(vm_name, username, password, ssh_pubkey)
    if os_family == "autoinstall":
        return build_autoinstall_iso(vm_name, username, password, ssh_pubkey)
    if os_family == "alpine":
        return build_alpine_seed_iso(vm_name, username, password, ssh_pubkey)
    raise ValueError(f"Famille d'OS non gérée : {os_family}")
