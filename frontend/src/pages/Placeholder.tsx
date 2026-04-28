// Placeholder for routes whose real implementation lands in later pilot
// prompts. Renders the breadcrumb-matching page title and a single line
// pointing at the prompt that will flesh it out (or "v1.0" for pages
// explicitly deferred per PROJECT_CONTEXT §8).

import { CRUMBS } from "../shell/nav";

interface Props {
  pageId: string;
}

// Maps each NAV id to the pilot phase that delivers it, or "v1.0" for
// pages explicitly deferred per PROJECT_CONTEXT §8.
const COMING_IN: Record<string, string> = {
  dashboard: "P12",
  live: "v1.0",
  calendar: "v1.0",
  cameras: "P7",
  employees: "P6",
  policies: "v1.0",
  "leave-policy": "v1.0",
  "daily-attendance": "P12",
  "camera-logs": "P11",
  pipeline: "v1.0",
  approvals: "v1.0",
  reports: "P13",
  "employee-report": "P13",
  "mgr-assign": "v1.0",
  audit: "P11",
  system: "P11",
  "api-docs": "v1.0",
  settings: "v1.0",
  "my-attendance": "P12",
  "team-attendance": "P12",
  "my-requests": "v1.0",
  "my-profile": "P6",
};

function titleFor(pageId: string): string {
  const crumbs = CRUMBS[pageId];
  return crumbs?.[crumbs.length - 1] ?? pageId;
}

export function Placeholder({ pageId }: Props) {
  const target = COMING_IN[pageId] ?? "later";
  const hint = target === "v1.0" ? "Deferred to v1.0" : `Coming in ${target}`;
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{titleFor(pageId)}</h1>
        <p className="page-sub">{hint}</p>
      </div>
      <p style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 8 }}>
        This page is a pilot-scaffold placeholder. The real view is wired up
        by the pilot prompt above — see <code>pilot-plan.md</code>.
      </p>
    </>
  );
}
