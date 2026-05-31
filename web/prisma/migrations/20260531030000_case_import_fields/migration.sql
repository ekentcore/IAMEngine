-- CaseRequest: support idempotent ServiceNow import + list display
ALTER TABLE "CaseRequest" ADD COLUMN "subject" TEXT;
CREATE UNIQUE INDEX "CaseRequest_serviceNowCaseNumber_key" ON "CaseRequest"("serviceNowCaseNumber");
