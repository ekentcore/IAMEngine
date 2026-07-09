-- CreateIndex
CREATE INDEX "AuditLog_caseRequestId_idx" ON "AuditLog"("caseRequestId");

-- CreateIndex
CREATE INDEX "CaseRequest_clientId_idx" ON "CaseRequest"("clientId");

-- CreateIndex
CREATE INDEX "Job_status_mode_idx" ON "Job"("status", "mode");

-- CreateIndex
CREATE INDEX "Job_status_startedAt_idx" ON "Job"("status", "startedAt");

-- CreateIndex
CREATE INDEX "Job_status_progressAt_idx" ON "Job"("status", "progressAt");

-- CreateIndex
CREATE INDEX "Job_caseRequestId_idx" ON "Job"("caseRequestId");

-- CreateIndex
CREATE INDEX "Job_assignedAgentId_idx" ON "Job"("assignedAgentId");
