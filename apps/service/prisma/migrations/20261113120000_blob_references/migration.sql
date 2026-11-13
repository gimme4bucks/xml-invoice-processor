-- Documents in S3 (ADR 0016). With BLOB_STORE=s3 a blobs row is only the reference to an object
-- named by its sha256, so it has no content. The orphan collector looks rows up by sha256.
-- xip_app already has SELECT, INSERT and UPDATE on blobs; nothing is granted here.
ALTER TABLE "blobs" ALTER COLUMN "content" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "blobs_sha256_idx" ON "blobs"("sha256");
