# GB10 deployment — DLMF Relationship OS private-turn ingress

This bundle installs the PM-001F DLMF ingress as a loopback-only host service. It does not grant Relationship OS canonical-memory authority and does not activate the Relationship OS Worker.

## Safety boundary

The service must remain:

- loopback-only (`127.0.0.1` / port `8793` by default);
- protected by a distinct Bearer token even behind a tunnel;
- backed by PostgreSQL Canonical Memory state;
- scoped to one approved Relationship OS tenant and Nancy life DID;
- restricted to `relationship.private.<32 lowercase hex>` namespaces;
- backed by an authenticated Hindsight tenant endpoint;
- configured with a raw archive outside the repository and mode `0700`;
- exposed externally only through trusted TLS termination.

Hindsight canonical projection is a disposable retrieval sidecar. It does not own Canonical Memory and does not settle the OmniHarness materialization outbox.

## 1. Prepare the protected host environment

Create protected host directories using the intended non-root service identity:

```bash
SERVICE_USER="${USER}"
SERVICE_GROUP="$(id -gn)"

sudo install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 \
  /var/lib/dlmf \
  /var/lib/dlmf/relationship-os
sudo install -d -o root -g "$SERVICE_GROUP" -m 0750 /etc/dlmf
```

Install the environment template outside Git:

```bash
sudo install -o root -g "$SERVICE_GROUP" -m 0640 \
  deploy/gb10/relationship-os/ingress.env.example \
  /etc/dlmf/relationship-os.env
```

Replace every `REPLACE_WITH_...` value. The Hindsight key is required for the production Relationship OS ingress; do not reuse the DLMF ingress Bearer token.

Run the static fail-closed preflight from the DLMF repository:

```bash
set -a
. /etc/dlmf/relationship-os.env
set +a
node scripts/check-relationship-os-ingress-config.mjs /etc/dlmf/relationship-os.env
```

Expected:

```text
DLMF_RELATIONSHIP_OS_CONFIG_PREFLIGHT=PASS
```

The checker prints no credentials or database URL.

## 2. Re-verify and build the exact candidate

```bash
cd /workspace/digital-life-memory-fabric
npm ci
npm run check
```

Do not install a service from a different checkout than the reviewed candidate.

## 3. Bootstrap the dedicated schema and raw archive

With `/etc/dlmf/relationship-os.env` loaded:

```bash
npm run relationship-os:bootstrap
```

Expected:

```text
DLMF_RELATIONSHIP_OS_BOOTSTRAP=PASS
```

Bootstrap is intentionally non-destructive:

- an empty configured schema receives migrations `0001`–`0004`;
- an already-complete schema is verified only;
- a partially initialized schema fails closed instead of guessing a repair.

The archive directory is created/chmodded to `0700`.

## 4. Render and install the systemd unit

Resolve the host values before installation:

```bash
SERVICE_USER="${USER}"
SERVICE_GROUP="$(id -gn)"
NODE_BIN="$(command -v node)"

sed \
  -e "s|REPLACE_WITH_SERVICE_USER|$SERVICE_USER|g" \
  -e "s|REPLACE_WITH_SERVICE_GROUP|$SERVICE_GROUP|g" \
  -e "s|REPLACE_WITH_NODE_BIN|$NODE_BIN|g" \
  deploy/gb10/relationship-os/dlmf-relationship-os.service.in \
  > /tmp/dlmf-relationship-os.service

cat /tmp/dlmf-relationship-os.service
sudo install -o root -g root -m 0644 \
  /tmp/dlmf-relationship-os.service \
  /etc/systemd/system/dlmf-relationship-os.service
sudo systemctl daemon-reload
sudo systemctl enable --now dlmf-relationship-os.service
```

CatDesk's workspace shell is not proof of the GB10 host systemd state. Run these commands from the real host shell.

## 5. Local service acceptance

First check liveness without exposing private state:

```bash
curl -fsS http://127.0.0.1:8793/health
```

Then prove authentication occurs before request parsing:

```bash
curl -sS -o /tmp/dlmf-unauth.json -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8793/v1/relationship-os/retrievals \
  -H 'Content-Type: application/json' \
  --data '{ definitely not json'
```

Expected HTTP `401`. Do not paste real private text into this probe.

With the configured Bearer, submit a deliberately forbidden namespace to prove the scope gate without touching Hindsight/Canonical Memory:

```bash
curl -sS -o /tmp/dlmf-scope.json -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8793/v1/relationship-os/retrievals \
  -H "Authorization: Bearer $DLMF_RELATIONSHIP_OS_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{\"scope\":{\"tenantId\":\"$DLMF_RELATIONSHIP_OS_TENANT_ID\",\"lifeDid\":\"$DLMF_RELATIONSHIP_OS_LIFE_DID\",\"memoryNamespace\":\"forbidden.namespace\"},\"query\":\"probe\",\"topK\":1}"
```

Expected HTTP `400` with the public scope error. Do not call the real Relationship namespace until the integration UAT is ready.

## 6. TLS / Cloudflare Tunnel

The DLMF server itself refuses non-loopback binds. Terminate public TLS in the stable Relationship OS tunnel prepared by the Relationship OS deployment bundle and route the DLMF hostname to:

```text
http://127.0.0.1:8793
```

The public endpoint still requires `DLMF_RELATIONSHIP_OS_BEARER_TOKEN`. A tunnel is transport, not authorization.

## 7. Worker handoff

Only after local + public DLMF acceptance passes should Relationship OS receive:

```text
DLMF_BASE_URL=https://<stable-dlmf-host>/
DLMF_TENANT_ID=<exact configured tenant>
DLMF_LIFE_DID=<exact configured Nancy DID>
DLMF_TOKEN=<same DLMF ingress bearer, stored as Worker secret>
```

Keep `REACTIVE_MESSAGING_ENABLED=false` while these values are first deployed. Real Telegram activation belongs to the final PM-001F UAT gate.
