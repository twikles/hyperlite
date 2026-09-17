# Dépôt APT Hyperlite

**Source recommandée (par défaut sur les appliances, voir installer/postinstall.sh)** :
servie directement par kvm-lab en Tailscale, sans CDN intermédiaire -- seule
source dont la cohérence InRelease/Packages est garantie (voir CLAUDE.md,
section "GitHub Pages, incohérence CDN persistante" pour le pourquoi).
Fonctionne uniquement pour une machine déjà sur le réseau Tailscale d'Antho :

```bash
curl -fsSL http://100.88.184.24:8899/hyperlite-archive-keyring.asc | gpg --dearmor -o /usr/share/keyrings/hyperlite-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hyperlite-archive-keyring.gpg] http://100.88.184.24:8899 stable main" > /etc/apt/sources.list.d/hyperlite.list
apt update && apt install hyperlite
```

**Miroir public (GitHub Pages)** -- utile hors Tailscale, mais la cohérence
entre InRelease et Packages n'est PAS garantie à tout instant (CDN
multi-nœuds sans consistance forte, confirmé en conditions réelles) :

```bash
curl -fsSL https://twikles.github.io/hyperlite/hyperlite-archive-keyring.asc | gpg --dearmor -o /usr/share/keyrings/hyperlite-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hyperlite-archive-keyring.gpg] https://twikles.github.io/hyperlite stable main" > /etc/apt/sources.list.d/hyperlite.list
apt update && apt install hyperlite
```
