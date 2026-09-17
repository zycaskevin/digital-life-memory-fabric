# DLCORE-003B — DLMF Native Observation Adapter

**Status:** local candidate PASS  
**Scope:** per-life Digital-Life-Stack ingress observation only

DLMF remains canonical Memory authority. This milestone adds an optional bound Memory
scope to the existing `dlmf/digital-life-stack/v1` ingress and a read-only projection
for Digital Life Core conformance.

## Bound ingress

A DLMF ingress may now be configured with exactly one `MemoryScope`:

```text
DLMF_DLS_SCOPE_TENANT_ID
DLMF_DLS_SCOPE_LIFE_DID
DLMF_DLS_SCOPE_MEMORY_NAMESPACE
```

All three values are required together. When absent, existing unbound behavior is
preserved for compatibility and `/health` reports `scopeBound=false`. When present,
experience ingestion and retrieval reject every non-identical scope before calling
Memory Intelligence, canonical admission, or retrieval providers.

`/health` and `/ready` expose only bounded scope metadata plus authority/contract,
readiness and observation time. They do not expose memory content.

## Identity boundary

A DLMF scope `lifeDid` is not assumed to equal the canonical Digital Life Identity.
The Core-facing component manifest binds to the canonical DLI root. The owner-side
adapter independently asks Lifetime Hub to verify that the AgentDefinition's immutable
`memory_scope_ref` is the expected DLMF scope reference.

Current v0.1 AgentDefinition references encode:

```text
dlmf://scope/<dlmf-scope-lifeDid>/<memoryNamespace>
```

The DLMF `tenantId` remains an explicit operator/configuration scope field but is not
currently encoded in Lifetime Hub's v0.1 `memory_scope_ref`. Therefore this milestone
does not claim that Lifetime Hub independently attests tenant identity. The exact
native DLMF scope is still enforced by the ingress itself.

## Read-only observation

`scripts/digital-life-core-observation.mjs`:

1. pins the exact operator-selected Core component manifest;
2. loads an explicit expected DLMF MemoryScope;
3. obtains a read-only `memory-scope` binding verification from Lifetime Hub;
4. performs GET-only loopback requests to native `/health` and `/ready`;
5. requires `scopeBound=true`, exact scope, DLMF authority and contract;
6. projects `digital-life.health.v1` observations bound to the canonical DLI root.

It does not ingest experience, retrieve memory, distill, promote, repair schema,
activate a component, or authorize attachment.

The synthetic native-process smoke uses an actual `DigitalLifeStackDlmfIngress` on a
temporary loopback server and a temporary real Lifetime Hub AgentDefinition. It proves
zero Lifetime Hub writes during observation and zero DLMF Memory operations.
