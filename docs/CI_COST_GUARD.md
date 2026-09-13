# CI Cost Guard

**Status:** Active for pull-request verification

This repository uses the Agentic SDD Governance CI cost contract at `.sddgov/ci-cost-guard.json`.

Before push, run:

```bash
sddgov ci verify .
sddgov ci local-gate .
```

The local gate starts an isolated loopback-only PostgreSQL 16 container, runs the complete DLMF typecheck/test/build suite with all PostgreSQL tests enabled, removes the container, and rejects whitespace errors introduced after the current remote feature-branch baseline. Historical Markdown hard-break spacing already present in the branch is not rewritten by this work package.

Hosted CI rules:

- one non-draft pull-request run per work package;
- one rerun of the same revision only for a proven transient provider or runner failure;
- read-only GitHub permissions, concurrency cancellation, and per-job timeout are mandatory;
- post-merge verification is manual only and must use `workflow_dispatch`;
- a skipped, cancelled, zero-step, or stale run is not release evidence.

The guard does not authorize merge, deployment, production activation, schema upgrade, credentials, or access to Hermes private content.
