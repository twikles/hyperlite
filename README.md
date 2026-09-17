# Dépôt APT Hyperlite

Sur une appliance/machine à faire pointer vers ce dépôt :

```bash
curl -fsSL https://twikles.github.io/hyperlite/hyperlite-archive-keyring.asc | gpg --dearmor -o /usr/share/keyrings/hyperlite-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hyperlite-archive-keyring.gpg] https://twikles.github.io/hyperlite stable main" > /etc/apt/sources.list.d/hyperlite.list
apt update && apt install hyperlite
```
