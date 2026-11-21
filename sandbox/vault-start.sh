#!/bin/bash
# Per-sandbox: start the 1Claw binding proxy and a TLS front, and point the API host at this machine.
HOST=$1; BINDING=$2
set -a; . ~/dd/.1claw; set +a
export ONECLAW_PROXY_TOKEN="ddp_$(openssl rand -hex 16)"
printf '%s' "$ONECLAW_PROXY_TOKEN" > ~/dd/.proxy-token
nohup 1claw agent binding proxy "$BINDING" -p 8787 > ~/dd/proxy.log 2>&1 &
# A certificate for this API host, signed by the sandbox's own authority (already trusted on this machine).
mkdir -p ~/dd/cert && cd ~/dd/cert
openssl req -newkey rsa:2048 -nodes -subj "/CN=$HOST" -keyout host.key -out host.csr 2>/dev/null
printf 'subjectAltName=DNS:%s\n' "$HOST" > san.ext
openssl x509 -req -in host.csr -CA ~/ddvault/ca.crt -CAkey ~/ddvault/ca.key -CAcreateserial -days 2 -extfile san.ext -out host.crt 2>/dev/null
NODE=$(readlink -f "$(command -v node)")
sudo nohup "$NODE" ~/dd/vault/tls.mjs ~/dd/cert http://127.0.0.1:8787 > ~/dd/tls.log 2>&1 &
grep -q " $HOST\$" /etc/hosts || echo "127.0.0.1 $HOST" | sudo tee -a /etc/hosts >/dev/null
: > ~/dd/.1claw
for i in $(seq 1 40); do curl -s -o /dev/null "https://$HOST/" && { echo vault-ok; exit 0; }; sleep 0.5; done
echo vault-failed; cat ~/dd/tls.log | head -5; exit 1
