// A list an operator TYPES (a case fill-in, "additional groups"): split on ";" when there is one, else
// on ",". Semicolons are what let a name that contains a comma ("Sales, East; Finance") be entered at
// all (FR #174); a plain comma list reads exactly as it always has.
export function splitTypedList(s: string): string[] {
  return s.split(s.includes(";") ? ";" : ",").map((x) => x.trim()).filter((x) => x !== "");
}

// Payload fields that hold a LIST (the intake stores them as arrays). A typed value for one of these is
// stored as an array too, so every reader sees the same shape the intake produced.
export const LIST_PAYLOAD_FIELDS = new Set([
  "productLicenses", "securityGroups", "emailDistroGroups", "sharedMailboxes", "fileShareAccess", "cloudApplications",
]);
