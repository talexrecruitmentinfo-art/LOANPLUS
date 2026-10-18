CREATE TABLE "website_content_revisions" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "content" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "website_content_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "website_content_revisions_version_key" ON "website_content_revisions"("version");
CREATE INDEX "website_content_revisions_status_updatedAt_idx" ON "website_content_revisions"("status", "updatedAt");
CREATE UNIQUE INDEX "website_content_revisions_one_draft_idx" ON "website_content_revisions"("status") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "website_content_revisions_one_published_idx" ON "website_content_revisions"("status") WHERE "status" = 'PUBLISHED';

ALTER TABLE "website_content_revisions"
ADD CONSTRAINT "website_content_revisions_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "superadmin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "website_content_revisions"
ADD CONSTRAINT "website_content_revisions_publishedById_fkey"
FOREIGN KEY ("publishedById") REFERENCES "superadmin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
