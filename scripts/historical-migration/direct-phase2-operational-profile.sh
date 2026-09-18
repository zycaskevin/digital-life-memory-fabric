#!/usr/bin/env bash
# Source from the existing Direct-phase2 wrappers; never an authority bypass.
# These execution limits do NOT change migration identity, source eligibility,
# admission policies, bank IDs, or Canonical content. Explicit overrides remain
# bounded by the pilot's existing validators.
export DLMF_MIGRATION_MAX_UNITS="${DLMF_MIGRATION_MAX_UNITS:-32}"
export DLMF_MIGRATION_CONCURRENCY="${DLMF_MIGRATION_CONCURRENCY:-4}"
export DLMF_MIGRATION_PROJECTION_MAX_ATTEMPTS="${DLMF_MIGRATION_PROJECTION_MAX_ATTEMPTS:-3}"
