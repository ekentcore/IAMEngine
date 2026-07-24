-- Remote "Install browser automation" directive: additive, mirrors restartRequested's lifecycle.
ALTER TABLE "Agent" ADD COLUMN "browserInstallRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Agent" ADD COLUMN "browserInstallRequestedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "browserInstallRequestedBy" TEXT;
ALTER TABLE "Agent" ADD COLUMN "browserInstallDeliveredAt" TIMESTAMP(3);
