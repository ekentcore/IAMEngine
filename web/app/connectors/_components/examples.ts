// Starter definitions the builder offers so an author begins from something that already validates,
// not a blank box. Kept as data (not inline JSX) so the runner-side shape and the UI can't drift.
export const HTTP_EXAMPLE = {
  version: 1,
  kind: "http",
  baseUrl: "https://api.vendor.com/v1",
  hosts: ["api.vendor.com"],
  auth: { type: "bearer", secretName: "custom-vendor-api" },
  defaults: { headers: { Accept: "application/json" } },
  operations: {
    "find-user": {
      request: { method: "GET", path: "/users?email={{user.email}}" },
      expect: { status: [200] },
      extract: { userId: "results.0.id" },
    },
    "create-user": {
      request: { method: "POST", path: "/users", body: { email: "{{user.email}}", name: "{{user.displayName}}" } },
      expect: { status: [201] },
      extract: { userId: "id" },
    },
    "disable-user": {
      request: { method: "POST", path: "/users/{{vars.userId}}/deactivate" },
      expect: { status: [200, 204] },
    },
  },
  lanes: {
    test: [{ op: "find-user", optional: true }],
    onboard: [{ op: "find-user" }, { op: "create-user", skipWhen: "vars.userId" }],
    offboard: [
      { op: "find-user" },
      { warnWhen: "!vars.userId", message: "no account found — nothing to offboard" },
      { op: "disable-user", when: "vars.userId" },
    ],
  },
};

export const BROWSER_EXAMPLE = {
  version: 1,
  kind: "browser",
  startUrl: "https://portal.vendor.com/login",
  credentials: { secretName: "custom-vendor-portal" },
  lanes: {
    offboard: [
      { type: "goto", url: "{{def.startUrl}}" },
      { type: "fill", target: { label: "Email" }, value: "{{secret.username}}" },
      { type: "click", target: { role: "button", name: "Next" } },
      { type: "fill", target: { label: "Password" }, value: "{{secret.password}}", secret: true },
      { type: "totp", target: { label: "Verification code" } },
      { type: "waitFor", target: { text: "Dashboard" } },
      { type: "fill", target: { placeholder: "Search users" }, value: "{{user.email}}" },
      { type: "click", target: { text: "Deactivate" } },
      { type: "expect", target: { text: "User deactivated" } },
    ],
  },
};
