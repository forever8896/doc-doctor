#!/bin/bash
# One-time image setup: 1Claw CLI, a sandbox-local certificate authority, and trust for it.
set -e
HOST=$1
sudo npm install -g @1claw/cli >/dev/null 2>&1
mkdir -p ~/ddvault && cd ~/ddvault
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=doc-doctor sandbox CA" -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=$HOST" -keyout host.key -out host.csr 2>/dev/null
printf 'subjectAltName=DNS:%s\n' "$HOST" > san.ext
openssl x509 -req -in host.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -extfile san.ext -out host.crt 2>/dev/null
sudo cp ca.crt /usr/local/share/ca-certificates/doc-doctor.crt && sudo update-ca-certificates >/dev/null 2>&1
sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")"
1claw --version
