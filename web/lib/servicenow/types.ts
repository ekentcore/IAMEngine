// Raw ServiceNow REST Table API shapes. No business logic here.
// With sysparm_display_value=all, every field comes back as { value, display_value }.

export type SnFieldValue = { value: string; display_value: string };

// A customer_account record, limited to the fields we request via sysparm_fields.
export type SnAccount = {
  sys_id: SnFieldValue;
  u_core_id: SnFieldValue;
  name: SnFieldValue;
  website: SnFieldValue;
  u_region: SnFieldValue;
  u_time_zone: SnFieldValue;
  u_support_status: SnFieldValue;
  u_comanaged_it: SnFieldValue;
  u_onboarding: SnFieldValue;
  u_offboarding: SnFieldValue;
  // Account hierarchy: children inherit the parent's modeled onboarding when they have none.
  // SN's field is `account_parent` (NOT `parent`).
  account_parent?: SnFieldValue;
};

export type SnListResponse<T> = { result: T[] };

export type SnConfig = {
  instanceUrl: string;
  username: string;
  password: string;
};
