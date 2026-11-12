-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "events" (
    "global_position" BIGSERIAL NOT NULL,
    "event_id" UUID NOT NULL,
    "stream_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("global_position")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_views" (
    "document_id" UUID NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "failure" JSONB,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL,

    CONSTRAINT "document_views_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "organisation_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "document_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("organisation_id","idempotency_key")
);

-- CreateTable
CREATE TABLE "blobs" (
    "key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blobs_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "events_event_id_key" ON "events"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "events_stream_version_key" ON "events"("stream_id", "version");

-- CreateIndex
CREATE INDEX "document_views_org_received_idx" ON "document_views"("organisation_id", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_org_hash_key" ON "idempotency_records"("organisation_id", "content_hash");


-- Outbox relay scans only unpublished rows.
CREATE INDEX "outbox_pending_idx" ON "outbox" ("created_at") WHERE "published_at" IS NULL;

-- Events are immutable: block UPDATE, DELETE and TRUNCATE for every role, the owner included.
CREATE FUNCTION forbid_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON "events"
  FOR EACH ROW EXECUTE FUNCTION forbid_event_mutation();

CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON "events"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_event_mutation();
