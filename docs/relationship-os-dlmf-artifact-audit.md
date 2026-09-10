# Relationship OS ↔ DLMF Artifact Audit

**Date:** 2026-09-10
**Status:** Canonical classification record
**Architecture decision:** Relationship OS is **not** a DLMF consumer.

## Purpose

This record prevents historical implementation artifacts from being mistaken for current production architecture. Existing files are retained because they contain implementation history, regression coverage, and prior deployment evidence. Retention does not grant them current architectural authority.

No Relationship OS service, schema, deployment, configuration, or runtime is modified or restarted by this audit.

## Classification

| Artifact | Classification | Current meaning |
| --- | --- | --- |
| `docs/relationship-os-private-turn-ingress.md` | Deprecated / development-only | Historical PM-001F design evidence; not an approved production integration |
| `src/ingress/relationship-os-http.ts` | Deprecated compatibility code | Retained for regression/history; not a formal DLMF consumer boundary |
| `src/ingress/relationship-os-runtime.ts` | Deprecated compatibility code | Retained to avoid destructive deletion and preserve prior tests |
| `scripts/relationship-os-ingress-bootstrap.mjs` | Deprecated compatibility tooling | Must not be used to migrate or upgrade Relationship OS under current architecture |
| `scripts/relationship-os-ingress-server.mjs` | Deprecated compatibility tooling | Must not be used to activate a Relationship OS DLMF service under current architecture |
| `scripts/relationship-os-ingress-config-lib.mjs` | Deprecated compatibility tooling | Static historical deployment validation only |
| `scripts/check-relationship-os-ingress-config.mjs` | Deprecated compatibility tooling | Static historical deployment validation only |
| `deploy/gb10/relationship-os/*` | Historical deployment bundle | Retained as evidence; not a current deployment/runbook target |
| `test/relationship-os-ingress.test.ts` | Historical regression test | Proves old boundary behavior only; does not define current architecture |
| `test/relationship-os-bootstrap.integration.test.ts` | Historical migration regression test | Preserves old migration evidence; must not be read as a future rollout requirement |
| `test/relationship-os-deployment.test.ts` | Historical deployment regression test | Preserves old hardening evidence only |
| SG-007/008/009 references to Relationship OS bootstrap/deployment | Historical decision evidence | Superseded for target architecture by this record and DLS integration v1 |

## Current rule

The only formal upper-system integration target for DLMF is `Digital-Life-Stack`.

Relationship OS owns its own commercial/product memory design and does not inherit DLMF deployment, migration, canonical-memory, Hindsight-provider, or readiness requirements from the Digital Life architecture.

Historical Relationship OS artifacts must therefore satisfy all of the following:

1. They may remain in Git history and the working tree for audit/regression purposes.
2. They must be visibly marked deprecated/development-only where a reader could otherwise mistake them for current runbooks or architecture.
3. They must not be invoked by new DLMF CI/deployment flows except as explicitly labeled legacy regression coverage.
4. They must not be upgraded, deployed, restarted, or connected to current Relationship OS production as part of DLMF work.
5. They must not be used as templates for deciding DLMF ownership; the active contract is `docs/digital-life-stack-integration-v1.md`.

## Non-destructive disposition

No historical file is deleted by this packet. Compatibility exports and package commands remain present so existing historical checkouts, tests, or an already-running process are not broken by repository cleanup. Their presence is not approval for future use.
