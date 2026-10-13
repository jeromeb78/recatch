// Who can do what in a shared account. Mirrors valid_permissions() / can_access() in the team migration.

export type Area = "receipts" | "reports" | "settings" | "team";
export type Level = "none" | "view" | "edit";
export type Perms = Record<Area, Level>;

export type Account = {
  ownerId: string;
  ownerEmail: string;
  own: boolean;
  perms: Perms;
};

export const FULL: Perms = { receipts: "edit", reports: "edit", settings: "edit", team: "edit" };
export const NONE: Perms = { receipts: "none", reports: "none", settings: "none", team: "none" };

export const AREAS: { key: Area; label: string; help: string; levels: Level[] }[] = [
  { key: "receipts", label: "Receipts", help: "Receipts, line items, photos, SKUs, the review queue and snapping new receipts", levels: ["none", "view", "edit"] },
  { key: "reports", label: "Reports & taxes", help: "Write-offs, mileage, inventory/COGS and accountant exports", levels: ["none", "view", "edit"] },
  { key: "settings", label: "Settings", help: "Business description, categories and connected inboxes", levels: ["none", "view", "edit"] },
  { key: "team", label: "Team", help: "Invite people and change what they can do", levels: ["none", "edit"] },
];

export const LEVEL_LABEL: Record<Level, string> = { none: "No access", view: "Can view", edit: "Can edit" };

export const PRESETS: { key: string; label: string; help: string; perms: Perms }[] = [
  { key: "bookkeeper", label: "Bookkeeper", help: "Works on receipts and taxes, can see settings", perms: { receipts: "edit", reports: "edit", settings: "view", team: "none" } },
  { key: "assistant", label: "Assistant", help: "Adds and fixes receipts only", perms: { receipts: "edit", reports: "none", settings: "none", team: "none" } },
  { key: "accountant", label: "Accountant (read-only)", help: "Sees receipts and reports, changes nothing", perms: { receipts: "view", reports: "view", settings: "none", team: "none" } },
  { key: "admin", label: "Admin", help: "Everything, including inviting people", perms: FULL },
];

const RANK: Record<Level, number> = { none: 0, view: 1, edit: 2 };

export function allows(perms: Perms, area: Area, level: Exclude<Level, "none"> = "view"): boolean {
  return RANK[perms[area] ?? "none"] >= RANK[level];
}

export function presetFor(perms: Perms): string {
  return PRESETS.find((p) => AREAS.every((a) => p.perms[a.key] === perms[a.key]))?.key ?? "custom";
}

export function describePerms(perms: Perms): string {
  const parts = AREAS.filter((a) => perms[a.key] !== "none").map((a) =>
    a.key === "team" ? "manage team" : `${perms[a.key]} ${a.label.toLowerCase()}`
  );
  return parts.length ? parts.join(", ") : "no access";
}
