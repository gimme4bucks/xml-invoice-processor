-- Least-privilege runtime role (ADR 0003): the application may read and append events, but never
-- change or remove them, and it may not delete anything else either. The trigger from the init
-- migration stays as a second line of defence (it also stops the owner).
--
-- xip_app cannot log in. A deployment creates a login user that is a member, for example:
--   CREATE ROLE xip_service LOGIN PASSWORD '<from the secret store>' IN ROLE xip_app;
-- and keeps the owner (who runs these migrations) out of the application's DATABASE_URL.
--
-- Roles are cluster-wide while this migration runs once per schema, so creating it tolerates an
-- existing role. Tables added by later migrations need their own GRANTs.

DO $$
BEGIN
  CREATE ROLE xip_app NOLOGIN;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN
    NULL; -- created earlier for another schema or database
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO xip_app', current_schema());
END
$$;

GRANT SELECT, INSERT ON "events" TO xip_app;
GRANT USAGE ON SEQUENCE "events_global_position_seq" TO xip_app;
GRANT SELECT, INSERT ON "idempotency_records" TO xip_app;
-- Upserts (read model, blobs) and the relay (published_at, attempts) need UPDATE; FOR UPDATE too.
GRANT SELECT, INSERT, UPDATE ON "document_views", "blobs", "outbox" TO xip_app;
