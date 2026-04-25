// End-to-end pilot smoke (P13).
//
// Flow (matches pilot-plan P13):
//   1. log in as admin via the UI
//   2. import a sample Excel (one employee) via the API
//   3. upload a sample photo for that employee via the API
//   4. seed a synthetic detection via the dev-only /api/_test/seed_detection
//   5. trigger an attendance recompute via the dev-only endpoint
//   6. open the Reports page, click "Generate Excel"
//   7. parse the downloaded XLSX and assert the expected row landed
//   8. clean up the seeded employee + camera + events
//
// Requires the live compose stack and HADIR_ENV=dev. Run with:
//   docker compose up -d
//   cd frontend && npm install && npx playwright install chromium
//   npm run smoke

import { test, expect, request } from "@playwright/test";
import ExcelJS from "exceljs";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADMIN_EMAIL = process.env.HADIR_SMOKE_EMAIL ?? "admin@pilot.hadir";
const ADMIN_PASSWORD = process.env.HADIR_SMOKE_PASSWORD ?? "pilot-admin-pw-8f2a";
const SAMPLE_EMPLOYEE_CODE = "P13-SMOKE";
const SAMPLE_EMPLOYEE_NAME = "Pilot Smoke";

// 1×1 JPEG sufficient to satisfy openpyxl's read path on the backend
// without needing a real face — the smoke uses the dev-only seed
// endpoint to drive the rest of the identification flow.
const TINY_JPEG_HEX =
  "ffd8ffe000104a46494600010100000100010000ffdbffd9";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function buildSampleXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Employees");
  ws.addRow(["employee_code", "full_name", "email", "department_code"]);
  ws.addRow([
    SAMPLE_EMPLOYEE_CODE,
    SAMPLE_EMPLOYEE_NAME,
    "smoke@p13.example",
    "ENG",
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("pilot smoke: login → import → photo → seed → recompute → report", async ({
  page,
  baseURL,
}) => {
  const apiContext = await request.newContext({ baseURL });

  // 1) UI login proves the auth flow + cookie behaviour end-to-end.
  await page.goto("/login");
  await page.locator("input[type='email']").fill(ADMIN_EMAIL);
  await page.locator("input[type='password']").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  // Reuse the browser's cookies for the API context.
  const cookies = await page.context().cookies();
  await apiContext.storageState({ path: undefined });
  for (const c of cookies) {
    await apiContext.storageState();
    // Playwright's APIRequestContext shares storage with the browser
    // context when constructed from `request.newContext({ storageState })`,
    // but the simplest reliable approach for the smoke is to log in via
    // the API too — same credentials, same cookie jar.
  }
  const loginResp = await apiContext.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(loginResp.status()).toBe(200);

  // 2) Import a one-row sample XLSX.
  const xlsx = await buildSampleXlsx();
  const importResp = await apiContext.post("/api/employees/import", {
    multipart: {
      file: {
        name: "p13_smoke.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: xlsx,
      },
    },
  });
  expect(importResp.status()).toBe(200);
  const importBody = await importResp.json();
  // Either created (first run) or updated (re-run) is fine for the smoke.
  expect(importBody.created + importBody.updated).toBeGreaterThanOrEqual(1);
  expect(importBody.errors).toEqual([]);

  // 3) Upload one tiny photo through the bulk endpoint (which infers
  //    employee_code + angle from the filename).
  const photoBytes = Buffer.from(TINY_JPEG_HEX, "hex");
  const photoResp = await apiContext.post("/api/employees/photos/bulk", {
    multipart: {
      files: {
        name: `${SAMPLE_EMPLOYEE_CODE}.jpg`,
        mimeType: "image/jpeg",
        buffer: photoBytes,
      },
    },
  });
  expect(photoResp.status()).toBe(200);
  const photoBody = await photoResp.json();
  expect(photoBody.accepted.length).toBeGreaterThanOrEqual(1);

  // 4) Seed a synthetic detection via the dev-only endpoint.
  const seedResp = await apiContext.post("/api/_test/seed_detection", {
    data: { employee_code: SAMPLE_EMPLOYEE_CODE, minutes_offset: -2 },
  });
  expect(seedResp.status()).toBe(200);
  const seeded = await seedResp.json();
  expect(seeded.detection_event_id).toBeGreaterThan(0);

  // 5) Synchronously recompute today's attendance.
  const recomputeResp = await apiContext.post(
    "/api/_test/recompute_attendance",
  );
  expect(recomputeResp.status()).toBe(200);

  // 6) Generate the report through the UI — the new P13 surface.
  await page.goto("/reports");
  // Make sure the date inputs at least include today (they default to a
  // 7-day window ending today).
  const today = todayIso();
  await page.locator("input[type='date']").nth(1).fill(today);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /generate excel/i }).click();
  const download = await downloadPromise;

  // 7) Save and parse the downloaded XLSX. exceljs reads
  //    write_only-built workbooks fine.
  const downloadPath = join(tmpdir(), `p13_smoke_${Date.now()}.xlsx`);
  await download.saveAs(downloadPath);
  expect(existsSync(downloadPath)).toBe(true);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(downloadPath));
  let foundRow = false;
  wb.eachSheet((sheet) => {
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const code = row.getCell(1).value;
      if (code === SAMPLE_EMPLOYEE_CODE) {
        foundRow = true;
      }
    });
  });
  expect(foundRow, "expected the seeded employee row in the report").toBe(true);

  // Clean up the downloaded file.
  try {
    unlinkSync(downloadPath);
  } catch {
    /* best effort */
  }

  // 8) Best-effort cleanup so the next run starts clean. We delete the
  //    employee (CASCADE removes their detection_events and
  //    attendance_records via FK rules); the placeholder camera the
  //    seed_detection endpoint may have created is left in place.
  const empListResp = await apiContext.get(
    `/api/employees?q=${encodeURIComponent(SAMPLE_EMPLOYEE_CODE)}&include_inactive=true`,
  );
  if (empListResp.status() === 200) {
    const list = await empListResp.json();
    for (const item of list.items ?? []) {
      await apiContext.delete(`/api/employees/${item.id}`);
    }
  }
});
