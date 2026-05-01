-- ChampionAccess: grants champion-level Impact Hub access to existing Trellis users
-- without creating a duplicate ChampionUser record. Trellis password is reused.
-- Run once against Railway PostgreSQL.

CREATE TABLE IF NOT EXISTS "ChampionAccess" (
  "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"      uuid        NOT NULL,
  "affiliateId" uuid        NULL,
  "granted_by"  text        NOT NULL,
  "granted_at"  timestamptz NOT NULL DEFAULT NOW(),
  "deleted_at"  integer     NOT NULL DEFAULT 0,
  CONSTRAINT "ChampionAccess_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "ChampionAccess_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id")
);

-- One active grant per Trellis user. Soft-deleted rows (deleted_at != 0) are ignored.
CREATE UNIQUE INDEX IF NOT EXISTS "ChampionAccess_userId_active_idx"
  ON "ChampionAccess" ("userId")
  WHERE "deleted_at" = 0;

CREATE INDEX IF NOT EXISTS "ChampionAccess_affiliateId_idx"
  ON "ChampionAccess" ("affiliateId")
  WHERE "deleted_at" = 0;
