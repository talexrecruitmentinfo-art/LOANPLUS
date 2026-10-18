CREATE TABLE "system_health_components" (
    "component" VARCHAR(80) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "explanation" VARCHAR(500) NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER,
    "lastSuccessAt" TIMESTAMP(3),
    "affectedModules" JSONB NOT NULL DEFAULT '[]',
    "recommendedAction" VARCHAR(300) NOT NULL,

    CONSTRAINT "system_health_components_pkey" PRIMARY KEY ("component")
);

CREATE TABLE "system_incidents" (
    "id" TEXT NOT NULL,
    "fingerprint" VARCHAR(160) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "component" VARCHAR(80) NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "severity" VARCHAR(16) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "description" VARCHAR(500) NOT NULL,
    "affectedModules" JSONB NOT NULL DEFAULT '[]',
    "diagnosticEvidence" JSONB NOT NULL DEFAULT '{}',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveredAt" TIMESTAMP(3),
    "recoveryEvidence" VARCHAR(300),
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" VARCHAR(80),

    CONSTRAINT "system_incidents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "system_incident_notes" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "actorId" VARCHAR(80) NOT NULL,
    "note" VARCHAR(1000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_incident_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "system_incident_alerts" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "failureCategory" VARCHAR(80),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "system_incident_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "system_incidents_fingerprint_key" ON "system_incidents"("fingerprint");
CREATE INDEX "system_incidents_status_severity_lastSeenAt_idx" ON "system_incidents"("status", "severity", "lastSeenAt");
CREATE INDEX "system_incidents_component_firstSeenAt_idx" ON "system_incidents"("component", "firstSeenAt");
CREATE INDEX "system_incident_notes_incidentId_createdAt_idx" ON "system_incident_notes"("incidentId", "createdAt");
CREATE UNIQUE INDEX "system_incident_alerts_incidentId_key" ON "system_incident_alerts"("incidentId");
CREATE INDEX "system_incident_alerts_status_attemptedAt_idx" ON "system_incident_alerts"("status", "attemptedAt");

ALTER TABLE "system_incident_notes"
ADD CONSTRAINT "system_incident_notes_incidentId_fkey"
FOREIGN KEY ("incidentId") REFERENCES "system_incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "system_incident_alerts"
ADD CONSTRAINT "system_incident_alerts_incidentId_fkey"
FOREIGN KEY ("incidentId") REFERENCES "system_incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
