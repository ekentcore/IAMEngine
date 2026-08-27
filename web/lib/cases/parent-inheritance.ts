// Account-hierarchy inheritance, in ONE place.
//
// A child with NO modeled systems of its own plans with its PARENT's runbook (e.g. CORE2181..89 inherit
// CORE1456). Systems come wholesale from the parent; the modeling inputs fall back individually, so
// anything the child HAS set still wins. Adding systems to the child later automatically ends the
// inheritance, and a child whose inheritParentSystems was switched off never inherits.
//
// This lived only in clientForPlanning (the INITIAL plan). replanInputs (the RE-PLAN) selected the
// child's own systems and had no fallback at all, so a re-plan on such a child planned ZERO jobs — 77%
// of their re-plans, against 2% everywhere else. Nothing planned meant nothing for the requested-groups
// merge to land on, which is how a ticket's distribution groups were pulled onto the case and then added
// to nobody (FR #0000042). Extracted rather than copied precisely because the two paths already drifted
// once.
export type InheritableChild = {
  systems: unknown[];
  identity: unknown; personas: unknown; globals: unknown; globalsOffboard: unknown;
  locations: unknown; adObjects: unknown; cloudGroups: unknown;
};
export type InheritableParent = Omit<InheritableChild, "systems"> & { systems: unknown[] };

export function inheritsFromParent(child: { systems: unknown[]; parentId: string | null; inheritParentSystems: boolean }): boolean {
  return child.systems.length === 0 && !!child.parentId && child.inheritParentSystems;
}

export function applyParentInheritance<C extends InheritableChild>(child: C, parent: InheritableParent | null): C {
  // A parent with no systems has no runbook to lend — leave the child exactly as it is rather than
  // blanking its modeling inputs against an empty parent.
  if (!parent || parent.systems.length === 0) return child;
  return {
    ...child,
    systems: parent.systems,
    identity: child.identity ?? parent.identity,
    personas: child.personas ?? parent.personas,
    globals: child.globals ?? parent.globals,
    globalsOffboard: child.globalsOffboard ?? parent.globalsOffboard,
    locations: child.locations ?? parent.locations,
    adObjects: child.adObjects ?? parent.adObjects,
    cloudGroups: child.cloudGroups ?? parent.cloudGroups,
  };
}

// The parent columns both planning paths need to read.
export const PARENT_INHERIT_SELECT = {
  identity: true, personas: true, globals: true, globalsOffboard: true,
  locations: true, systems: true, adObjects: true, cloudGroups: true,
} as const;
