-- ============================================================
-- Migration: ReportPeriodSnapshot table
-- Purpose : Stores mutable status field values as of a given
--           period end date so Q1 (and future) report numbers
--           are locked and won't drift as Trellis data changes.
-- Run with: node scripts/run-migration.js scripts/2026-05-29-report-period-snapshot.sql
-- Seed with: node scripts/generate-period-snapshot.js
-- ============================================================

CREATE TABLE IF NOT EXISTS "ReportPeriodSnapshot" (
  "id"             SERIAL       PRIMARY KEY,

  -- Period identifier, e.g. '2026-Q1', '2026-Q2', '2026-YTD'
  "period_key"     VARCHAR(10)  NOT NULL,

  -- The exact cutoff date this snapshot was taken as of
  "period_end"     DATE         NOT NULL,

  -- Which Trellis table this row came from: 'Mom', 'User', 'Child'
  "record_type"    VARCHAR(20)  NOT NULL,

  -- UUID of the record stored as TEXT (matches AuditLog data->>'id')
  "record_id"      TEXT         NOT NULL,

  -- The specific field being snapshotted, e.g. 'status', 'prospect_status'
  "field_name"     VARCHAR(100) NOT NULL,

  -- The field's value as of period_end (NULL if field was NULL at that time)
  "field_value"    TEXT,

  -- How the value was determined:
  --   'audit_log'          = reconstructed from the last AuditLog entry <= period_end
  --   'live_fallback'      = no AuditLog entry found; current live value used
  --                          (safe when record was created before period_end and
  --                           the field hasn't changed since — e.g. a new mom
  --                           who was never updated)
  --   'manual_correction'  = override entered after soft-lock for data corrections
  "source"         VARCHAR(30)  NOT NULL DEFAULT 'audit_log',

  -- When this snapshot row was written (tracks regenerations)
  "snapshotted_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- One row per (period, table, record, field) — ON CONFLICT DO UPDATE lets
  -- re-running the script after data corrections refresh the values.
  CONSTRAINT "rps_period_record_field"
    UNIQUE ("period_key", "record_type", "record_id", "field_name")
);

-- Supports the report query pattern: WHERE period_key = ? AND record_type = ?
-- AND field_name = ? (used in LEFT JOINs from Mom/User/Child)
CREATE INDEX IF NOT EXISTS "rps_period_type_field"
  ON "ReportPeriodSnapshot" ("period_key", "record_type", "field_name");

-- Supports lookup by record when joining individual rows
CREATE INDEX IF NOT EXISTS "rps_record_lookup"
  ON "ReportPeriodSnapshot" ("record_id", "period_key", "field_name");

COMMENT ON TABLE "ReportPeriodSnapshot" IS
  'Point-in-time snapshots of mutable Trellis status fields. '
  'Populated by scripts/generate-period-snapshot.js using AuditLog '
  'reconstruction (or live fallback). Prevents quarterly report numbers '
  'from drifting as status fields change in subsequent periods.';
