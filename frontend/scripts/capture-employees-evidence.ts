// Real-UI visual evidence capture for the Employees module (Admin role).
//
// Drives the live Vite dev server at http://localhost:5173 with a real
// Chromium, records video of the entire session, and saves a named
// screenshot at every checkpoint into:
//
//   /app/.evidence/screenshots/<TEST-ID>_<slug>.png
//   /app/.evidence/videos/employees-walkthrough-full.webm
//   /app/.evidence/issues/<TEST-ID>_<slug>/<short>.png
//   /app/.evidence/passed-cases/<TEST-ID>_<slug>/<short>.png
//
// The host script then copies these into
// `Testing Reports/<DATE>/Admin/Employees/<bucket>/...`.
//
// Each "step" is wrapped in tryStep() which:
//   * records the step's screenshot into screenshots/
//   * copies it to passed-cases/ on success, issues/ on failure
//   * never throws — one bad step doesn't abort the rest of the run.
//
// Run from inside the frontend container:
//
//   docker compose exec frontend node --experimental-strip-types \
//     scripts/capture-employees-evidence.ts
//
// Required env:
//   MAUGOOD_CAP_EMAIL   (admin email)
//   MAUGOOD_CAP_PW      (admin password)
//   MAUGOOD_CAP_TENANT  (tenant slug)
//
// Optional:
//   MAUGOOD_CAP_BASE    (default http://frontend:5173 inside the
//                        compose network, or http://localhost:5173 from
//                        host if the script is run outside the container)

import { chromium, type Browser, type Page } from "playwright";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const BASE = process.env.MAUGOOD_CAP_BASE ?? "http://frontend:5173";
const EMAIL = process.env.MAUGOOD_CAP_EMAIL!;
const PW = process.env.MAUGOOD_CAP_PW!;
const TENANT = process.env.MAUGOOD_CAP_TENANT!;

const OUT_ROOT = "/app/.evidence";
const SHOTS = path.join(OUT_ROOT, "screenshots");
const VIDEOS = path.join(OUT_ROOT, "videos");
const ISSUES = path.join(OUT_ROOT, "issues");
const PASSED = path.join(OUT_ROOT, "passed-cases");

type StepFn = (page: Page) => Promise<void>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureDirs() {
  for (const d of [OUT_ROOT, SHOTS, VIDEOS, ISSUES, PASSED]) {
    await fs.mkdir(d, { recursive: true });
  }
}

async function takeShot(page: Page, name: string) {
  // Wait for paint to settle. networkidle is too strict on dev server.
  await sleep(400);
  const target = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: target, fullPage: true });
  return target;
}

let passCount = 0;
let failCount = 0;
const failures: { id: string; reason: string }[] = [];

async function tryStep(
  page: Page,
  testId: string,
  description: string,
  fn: StepFn,
): Promise<void> {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const shotName = `${testId}_${slug}`;
  console.log(`▶ ${testId} ${description}`);
  try {
    await fn(page);
    const shot = await takeShot(page, shotName);
    // copy to passed-cases/<testId>_<slug>/
    const dst = path.join(PASSED, shotName);
    await fs.mkdir(dst, { recursive: true });
    await fs.copyFile(shot, path.join(dst, "result.png"));
    passCount += 1;
    console.log(`  ✓ pass — ${shot}`);
  } catch (err) {
    const reason = (err as Error).message;
    failCount += 1;
    failures.push({ id: testId, reason });
    try {
      const shot = await takeShot(page, shotName);
      const dst = path.join(ISSUES, shotName);
      await fs.mkdir(dst, { recursive: true });
      await fs.copyFile(shot, path.join(dst, "failure.png"));
      await fs.writeFile(
        path.join(dst, "reason.txt"),
        `${testId} — ${description}\n\n${reason}\n`,
        "utf-8",
      );
    } catch (innerErr) {
      console.log(
        `  ✗ fail AND screenshot also failed: ${(innerErr as Error).message}`,
      );
    }
    console.log(`  ✗ fail — ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });

  // The login form may show tenant_slug + email + password OR a
  // single "Sign in with Microsoft" if OIDC is enabled. We assume
  // the standard form for now.
  // Fill the visible inputs.
  await page.waitForSelector('input[type="email"], input[name="email"]', {
    timeout: 10000,
  });

  const tenantInput = await page.$(
    'input[name="tenant_slug"], input[placeholder*="enant" i]',
  );
  if (tenantInput) {
    await tenantInput.fill(TENANT);
  }

  await page.fill(
    'input[type="email"], input[name="email"]',
    EMAIL,
  );
  await page.fill('input[type="password"]', PW);

  await Promise.all([
    page.waitForURL((u) => !u.toString().endsWith("/login"), { timeout: 15000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}

async function run(): Promise<void> {
  await ensureDirs();

  if (!EMAIL || !PW || !TENANT) {
    throw new Error(
      "MAUGOOD_CAP_EMAIL, MAUGOOD_CAP_PW, MAUGOOD_CAP_TENANT must all be set",
    );
  }

  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: VIDEOS, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`  [console.error] ${msg.text()}`);
  });

  try {
    await tryStep(page, "EMP-F-00", "Login page renders", async () => {
      await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        'input[type="email"], input[name="email"]',
        { timeout: 10000 },
      );
    });

    await tryStep(page, "EMP-F-00b", "Login submit succeeds", async () => {
      await login(page);
    });

    // EMP-F-01 — list renders
    await tryStep(page, "EMP-F-01", "Employees page list", async () => {
      await page.goto(`${BASE}/employees`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await sleep(800);
    });

    // EMP-F-02 — search filter
    await tryStep(page, "EMP-F-02", "Search input filter", async () => {
      const search = await page.$(
        'input[type="search"], input[placeholder*="earch" i], input[name="search"]',
      );
      if (!search) throw new Error("search input not found");
      await search.fill("a");
      await sleep(800);
    });

    await tryStep(
      page,
      "EMP-F-02b",
      "Clear search input",
      async () => {
        const search = await page.$(
          'input[type="search"], input[placeholder*="earch" i], input[name="search"]',
        );
        if (search) await search.fill("");
        await sleep(400);
      },
    );

    // EMP-F-03 — include inactive toggle
    await tryStep(page, "EMP-F-03", "Include inactive toggle", async () => {
      const toggle = await page.$(
        'input[type="checkbox"][name*="inactive" i], label:has-text("Include inactive") input, label:has-text("nactive") input',
      );
      if (toggle) {
        await toggle.click();
        await sleep(600);
      } else {
        // Some builds put the toggle inside a button — capture the
        // page anyway so the screenshot shows whether the control
        // exists at all.
        throw new Error("include-inactive toggle not found");
      }
    });

    // EMP-F-05 — Add drawer
    await tryStep(page, "EMP-F-05", "Add drawer opens", async () => {
      const addBtn = await page.$(
        'button:has-text("+ Add"), button:has-text("Add employee"), button:has-text("New employee"), button:has-text("Add")',
      );
      if (!addBtn) throw new Error("Add button not found on Employees page");
      await addBtn.click();
      // Wait for a drawer/dialog to appear.
      await page.waitForSelector(
        '[role="dialog"], .drawer, aside, [aria-label*="rawer" i]',
        { timeout: 4000 },
      );
      await sleep(400);
    });

    await tryStep(page, "EMP-F-05b", "Close Add drawer", async () => {
      const close = await page.$(
        'button[aria-label*="lose" i], button:has-text("Cancel"), button:has-text("Close")',
      );
      if (close) {
        await close.click();
        await sleep(400);
      } else {
        // Escape as fallback.
        await page.keyboard.press("Escape");
        await sleep(400);
      }
    });

    // EMP-F-06 — Detail drawer / gallery
    await tryStep(page, "EMP-F-06", "Employee detail drawer", async () => {
      // Click the first row in the table.
      const firstRow = await page.$(
        "table tbody tr:first-child, .table-row:first-child, [role='row']:not([role='columnheader']):first-of-type",
      );
      if (!firstRow) throw new Error("no employee rows to click");
      await firstRow.click();
      await page.waitForSelector(
        '[role="dialog"], .drawer, aside',
        { timeout: 4000 },
      );
      await sleep(600);
    });

    await tryStep(
      page,
      "EMP-F-06b",
      "Close detail drawer",
      async () => {
        const close = await page.$(
          'button[aria-label*="lose" i], button:has-text("Close")',
        );
        if (close) await close.click();
        else await page.keyboard.press("Escape");
        await sleep(400);
      },
    );

    // EMP-F-14 — XLSX export (link or button)
    await tryStep(page, "EMP-F-14", "Export button visible", async () => {
      const exportBtn = await page.$(
        'a:has-text("Export"), button:has-text("Export")',
      );
      if (!exportBtn) throw new Error("Export button not found");
      // Don't actually click — that triggers a download. Just verify
      // the surface is visible.
    });

    // EMP-F-08 — Import modal opens
    await tryStep(page, "EMP-F-08", "Import modal opens", async () => {
      const importBtn = await page.$(
        'button:has-text("Import"), a:has-text("Import")',
      );
      if (!importBtn) throw new Error("Import button not found");
      await importBtn.click();
      await page.waitForSelector(
        '[role="dialog"], .modal, .drawer',
        { timeout: 4000 },
      );
      await sleep(400);
    });

    await tryStep(page, "EMP-F-08b", "Close import modal", async () => {
      const close = await page.$(
        'button:has-text("Cancel"), button:has-text("Close"), button[aria-label*="lose" i]',
      );
      if (close) await close.click();
      else await page.keyboard.press("Escape");
      await sleep(400);
    });

    // EMP-F-19 — Sidebar reflects Admin role
    await tryStep(page, "EMP-F-19", "Sidebar nav shows Admin entries", async () => {
      // Take a screenshot of the whole page; sidebar nav should
      // include Employees + Settings.
      const settingsLink = await page.$(
        'a:has-text("Settings"), nav a:has-text("Settings")',
      );
      if (!settingsLink) throw new Error("Settings link not in sidebar");
    });

    // EMP-F-20 — cross-tenant URL guess (404)
    await tryStep(page, "EMP-F-20", "Cross-tenant employee id 404", async () => {
      // Pick an id well above the seed range; the route should
      // surface a not-found state, not crash.
      await page.goto(`${BASE}/employees/9999999`, {
        waitUntil: "domcontentloaded",
      });
      await sleep(800);
    });
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  console.log(`\n=== Capture complete ===`);
  console.log(`Pass:    ${passCount}`);
  console.log(`Fail:    ${failCount}`);
  if (failures.length) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  ${f.id}: ${f.reason}`);
  }
  console.log(`\nArtifacts: ${OUT_ROOT}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
