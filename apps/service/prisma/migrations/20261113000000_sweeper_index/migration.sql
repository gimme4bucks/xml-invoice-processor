-- The sweeper (ADR 0014) looks for non-final documents whose read model has not changed for a
-- while: WHERE status IN ('Received', 'Processing') AND updated_at < cutoff.
CREATE INDEX "document_views_status_updated_idx" ON "document_views"("status", "updated_at");
