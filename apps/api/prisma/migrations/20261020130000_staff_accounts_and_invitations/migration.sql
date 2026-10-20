ALTER TYPE "Role" ADD VALUE 'STAFF_SUPPORT';
ALTER TYPE "Role" ADD VALUE 'STAFF_FINANCE';
ALTER TYPE "Role" ADD VALUE 'STAFF_OPERATIONS';

ALTER TABLE "superadmin_users"
ADD COLUMN "fullName" VARCHAR(160),
ADD COLUMN "phone" VARCHAR(16);

CREATE TABLE "staff_invitations" (
    "id" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_invitations_tokenHash_key" ON "staff_invitations"("tokenHash");
CREATE INDEX "staff_invitations_staffUserId_createdAt_idx" ON "staff_invitations"("staffUserId", "createdAt");
CREATE INDEX "staff_invitations_expiresAt_idx" ON "staff_invitations"("expiresAt");

ALTER TABLE "staff_invitations"
ADD CONSTRAINT "staff_invitations_staffUserId_fkey"
FOREIGN KEY ("staffUserId") REFERENCES "superadmin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "staff_invitations"
ADD CONSTRAINT "staff_invitations_invitedById_fkey"
FOREIGN KEY ("invitedById") REFERENCES "superadmin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
