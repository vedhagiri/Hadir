// Plain-language catalog for audit action codes.
//
// The backend classifies every action into a category + severity
// (maugood/audit_log/catalog.py). This file owns the *words*: one
// sentence per known action (i18n key ``auditLog.act.<code>`` with dots
// turned into underscores), a count-aware sentence for collapsed runs
// of identical events (``auditLog.group.<code>``), readable entity-type
// names and the in-app route an entity links to. Unknown actions fall
// back to a title-cased version of the code, so a new audit action is
// never hidden.

import type { TFunction } from "i18next";

import type { AuditEntry } from "./types";

export const ACTION_TEXT: Record<string, string> = {
  // Security
  "auth.login.success": "Signed in",
  "auth.login.failure": "Sign-in failed",
  "auth.login.rate_limited": "Sign-in blocked after too many attempts",
  "auth.logout": "Signed out",
  "auth.session.expired": "Session expired",
  "auth.session.refreshed": "Session refreshed",
  "auth.role.switched": "Switched active role",
  "auth.oidc.login.success": "Signed in with Microsoft",
  "auth.oidc.login.failure": "Microsoft sign-in failed",
  "auth.oidc.config_updated": "Microsoft sign-in settings changed",
  "auth.oidc.config_deleted": "Microsoft sign-in settings removed",
  "auth.google.login.success": "Signed in with Google",
  "auth.google.login.failure": "Google sign-in failed",
  "auth.google.config_updated": "Google sign-in settings changed",
  "auth.google.config_deleted": "Google sign-in settings removed",
  "super_admin.login.success": "MTS operator signed in",
  "super_admin.login.failure": "MTS operator sign-in failed",
  "super_admin.logout": "MTS operator signed out",
  "super_admin.access_as.start": "MTS operator started accessing this workspace",
  "super_admin.access_as.end": "MTS operator stopped accessing this workspace",
  "super_admin.tenant.provisioned": "Workspace provisioned by MTS",
  "super_admin.tenant.provision_failed": "Workspace provisioning failed",
  "super_admin.tenant.viewed": "MTS operator viewed the workspace",
  "user.password_reset": "User password reset",
  "entra.group_role.updated": "Azure AD group-to-role mapping changed",
  "report.signed_url_downloaded": "Report downloaded from an emailed link",
  // Personal settings
  "auth.preferred_language.updated": "Changed display language",
  "auth.preferred_theme.updated": "Changed theme",
  "auth.preferred_density.updated": "Changed display density",
  // People
  "tenant.provisioned": "Workspace created",
  "user.created": "User account created",
  "user.updated": "User account updated",
  "employee.created": "Employee added",
  "employee.updated": "Employee details updated",
  "employee.self_updated": "Employee updated their own profile",
  "employee.soft_deleted": "Employee deactivated",
  "employee.auto_deactivated": "Employee deactivated after relieving date",
  "employee.hard_deleted": "Employee permanently deleted",
  "employee.purged": "Employee record purged",
  "employee.bulk_deleted": "Employees deleted in bulk",
  "employee.imported": "Employees imported from Excel",
  "employee.exported": "Employee list exported",
  "employee.reports_to_set": "Reporting manager changed",
  "employee.custom_fields.updated": "Employee custom fields updated",
  pdpl_delete: "Personal data erased (PDPL request)",
  "photo.ingested": "Reference photo added",
  "photo.ingested_self": "Employee uploaded their own photo",
  "photo.rejected": "Reference photo rejected",
  "photo.approved": "Reference photo approved",
  "photo.viewed": "Viewed a reference photo",
  "photo.deleted": "Reference photo deleted",
  "photo.deleted_self": "Employee deleted their own photo",
  "department.created": "Department created",
  "department.updated": "Department updated",
  "department.deleted": "Department deleted",
  "department.imported": "Departments imported",
  "department.manager_assigned": "Department manager assigned",
  "department.manager_removed": "Department manager removed",
  "division.created": "Division created",
  "division.updated": "Division updated",
  "division.deleted": "Division deleted",
  "division.manager_assigned": "Division manager assigned",
  "division.manager_removed": "Division manager removed",
  "section.created": "Section created",
  "section.updated": "Section updated",
  "section.deleted": "Section deleted",
  "section.manager_assigned": "Section manager assigned",
  "section.manager_removed": "Section manager removed",
  "manager_assignment.created": "Manager assigned to employee",
  "manager_assignment.deleted": "Manager assignment removed",
  "manager_assignment.primary_set": "Primary manager set",
  "custom_field.created": "Custom field created",
  "custom_field.updated": "Custom field updated",
  "custom_field.deleted": "Custom field deleted",
  "custom_field.reordered": "Custom fields reordered",
  "unidentified_face.mapped": "Unknown face matched to an employee",
  "unidentified_face.mapped_attendance": "Unknown face matched and attendance updated",
  "unidentified_face.unmapped": "Face match undone",
  "delete_request.submitted": "Employee deletion requested",
  "delete_request.approved": "Employee deletion approved",
  "delete_request.rejected": "Employee deletion rejected",
  "delete_request.hr_self_approved": "Employee deletion approved by HR",
  "entra.sync.completed": "Azure AD user sync completed",
  // Attendance
  "attendance.regenerated": "Attendance recalculated",
  "attendance_calendar.day_viewed": "Viewed an attendance day",
  "attendance_calendar.exported": "Attendance calendar exported",
  "attendance_email.manual_send": "Attendance email sent manually",
  "attendance_email.config.updated": "Attendance email settings changed",
  "shift_policy.created": "Shift policy created",
  "shift_policy.updated": "Shift policy updated",
  "shift_policy.soft_deleted": "Shift policy archived",
  "shift_policy.hard_deleted": "Shift policy deleted",
  "shift_policy.default_set": "Default shift policy changed",
  "shift_policy.bulk_imported": "Shift policies imported",
  "policy_assignment.created": "Shift policy assigned",
  "policy_assignment.deleted": "Shift policy assignment removed",
  "holiday.created": "Holiday added",
  "holiday.updated": "Holiday updated",
  "holiday.deleted": "Holiday deleted",
  "holiday.bulk_imported": "Holidays imported",
  "leave_type.created": "Leave type created",
  "leave_type.updated": "Leave type updated",
  "leave_type.deleted": "Leave type deleted",
  "approved_leave.created": "Leave recorded",
  "approved_leave.updated": "Leave updated",
  "approved_leave.deleted": "Leave removed",
  "request.submitted": "Request submitted",
  "request.cancelled": "Request cancelled",
  "request.manager.approve": "Request approved by manager",
  "request.manager.reject": "Request rejected by manager",
  "request.hr.approve": "Request approved by HR",
  "request.hr.reject": "Request rejected by HR",
  "request.admin.approve": "Admin overrode request: approved",
  "request.admin.reject": "Admin overrode request: rejected",
  "request.attachment.uploaded": "Request attachment uploaded",
  "request.attachment.downloaded": "Request attachment downloaded",
  "request.attachment.deleted": "Request attachment deleted",
  "request_reason_category.created": "Request reason added",
  "request_reason_category.updated": "Request reason updated",
  "request_reason_category.deleted": "Request reason deleted",
  // Cameras & devices
  "camera.created": "Camera added",
  "camera.updated": "Camera settings changed",
  "camera.deleted": "Camera deleted",
  "camera.imported": "Cameras imported",
  "camera.exported": "Camera list exported",
  "camera.previewed": "Previewed a camera",
  "camera.metadata_updated": "Camera hardware details updated",
  "capture.worker.started_at_boot": "Camera worker started at boot",
  "capture.worker.start_failed": "Camera worker failed to start",
  "capture.worker.config_updated": "Camera capture settings applied",
  "capture.worker.detection_config_updated": "Detection settings applied to camera",
  "capture.worker.tracker_config_updated": "Tracker settings applied to camera",
  "capture.worker.detection_enabled_updated": "Camera face detection switched on or off",
  "capture.worker.recording_mode_updated": "Camera recording mode changed",
  "capture.worker.clip_recording_enabled_updated": "Camera clip recording switched on or off",
  "capture.worker.clip_encoding_config_updated": "Camera clip encoding changed",
  "capture.worker.live_matching_enabled_updated": "Camera live matching switched on or off",
  "capture.worker.clip_detection_source_updated": "Camera clip detection source changed",
  "live_capture.mjpg.subscribed": "Opened a live camera view",
  "live_capture.mjpg.unsubscribed": "Closed a live camera view",
  "live_capture.persons_mjpg.subscribed": "Opened a live person view",
  "live_capture.persons_mjpg.unsubscribed": "Closed a live person view",
  "live_view.opened": "Opened live view",
  "live_view.closed": "Closed live view",
  "live_feed.stream.opened": "Opened a live feed",
  "live_feed.stream.closed": "Closed a live feed",
  "device.created": "Attendance device added",
  "device.updated": "Attendance device updated",
  "device.deleted": "Attendance device deleted",
  "device.resynced": "Attendance device re-synced",
  "device.users_synced": "Device users synced",
  "device.users_auto_mapped": "Device users auto-mapped to employees",
  "device.user_mapped": "Device user mapped to employee",
  "device.push_token_rotated": "Device push token rotated",
  "detection_event.crop_viewed": "Viewed a face crop",
  "identification.reembedded": "Face embeddings rebuilt",
  "identification.rematched": "Faces re-matched",
  worker_restart_requested: "Camera worker restart requested",
  worker_restart_all_requested: "Restart of all camera workers requested",
  "pipeline.restart_all_and_recover": "All camera workers restarted and recovered",
  // Clips & storage
  "person_clip.deleted": "Clip video deleted",
  "person_clip.recovered_at_boot": "Clip recovered after restart",
  "person_clip.streamed": "Played a clip video",
  "person_clip.reprocess_started": "Clip reprocessing started",
  "person_clip.reprocess_completed": "Clip reprocessing completed",
  "person_clip.single_reprocess_completed": "Clip reprocessed",
  "clip_cleanup.auto_deleted_after_processing": "Clip video auto-deleted after processing",
  "clip_cleanup.auto_delete_setting_updated": "Auto-delete-after-processing setting changed",
  "clip_cleanup.daily_auto_executed": "Daily clip cleanup ran",
  "clip_cleanup.daily_setting_updated": "Daily clip cleanup setting changed",
  "clip_cleanup.executed": "Clip cleanup run manually",
  "clip_cleanup.retention_updated": "Clip retention period changed",
  "clip_pipeline.batch_submit_all": "All pending clips sent for processing",
  "clip_pipeline.batch_submitted": "Clip batch sent for processing",
  "clip_pipeline.recovered_at_boot": "Clip processing recovered after restart",
  "clip_pipeline.retry_failed": "Failed clips retried",
  "uploaded_video.created": "Video uploaded",
  "uploaded_video.processing_started": "Uploaded video processing started",
  "retention.swept": "Old records cleaned up by retention",
  "queue.cleared": "Processing queue cleared",
  "queue.history_reprocessed": "Queue history reprocessed",
  // Reports
  "report.generated": "Report generated",
  "report.former_employees_seen": "Former-employees report viewed",
  "report_schedule.created": "Report schedule created",
  "report_schedule.updated": "Report schedule updated",
  "report_schedule.deleted": "Report schedule deleted",
  "report_schedule.run_now": "Scheduled report run on demand",
  "pipeline_analytics.export_zip": "Pipeline analytics exported",
  "erp_export.config_updated": "ERP export settings changed",
  "audit_log.exported": "Audit log exported",
  // Settings
  "tenant_settings.updated": "Workspace settings changed",
  "system.clip_pipeline_config.updated": "Clip pipeline settings changed",
  "system.detection_config.updated": "Detection settings changed",
  "system.tracker_config.updated": "Tracker settings changed",
  "system.reconnect_config.updated": "Camera reconnect settings changed",
  "system.clip_encoding_config.updated": "Clip encoding settings changed",
  "branding.updated": "Branding changed",
  "branding.logo_uploaded": "Logo uploaded",
  "branding.logo_deleted": "Logo removed",
  "branding.display_name_updated": "Display name changed",
  "email_config.updated": "Email settings changed",
  "email_config.test_sent": "Test email sent",
};

/** Sentences for a collapsed run of N identical events (N ≥ 2). */
export const GROUP_TEXT: Record<string, string> = {
  "detection_event.crop_viewed": "Viewed {{n}} face crops",
  "photo.viewed": "Viewed {{n}} reference photos",
  "person_clip.streamed": "Played {{n}} clip videos",
  "person_clip.deleted": "Deleted {{n}} clip videos",
  "person_clip.recovered_at_boot": "Recovered {{n}} clips after restart",
  "clip_cleanup.auto_deleted_after_processing": "Auto-deleted {{n}} clip videos after processing",
  "employee.created": "Added {{n}} employees",
  "employee.updated": "Updated {{n}} employees",
  "employee.purged": "Purged {{n}} employee records",
  "employee.reports_to_set": "Changed the reporting manager of {{n}} employees",
  "attendance_calendar.day_viewed": "Viewed {{n}} attendance days",
  "capture.worker.started_at_boot": "Started {{n}} camera workers at boot",
  "auth.login.failure": "{{n}} failed sign-in attempts",
  "user.created": "Created {{n}} user accounts",
  "live_capture.mjpg.subscribed": "Opened live camera views {{n}} times",
  "live_capture.mjpg.unsubscribed": "Closed live camera views {{n}} times",
};

export const ENTITY_TEXT: Record<string, string> = {
  employee: "Employee",
  user: "User",
  camera: "Camera",
  person_clip: "Clip",
  person_clips: "Clip",
  detection_event: "Face crop",
  photo: "Photo",
  session: "Session",
  department: "Department",
  division: "Division",
  section: "Section",
  report: "Report",
  device: "Device",
  tenant_settings: "Workspace settings",
  shift_policy: "Shift policy",
  policy_assignment: "Policy assignment",
  holiday: "Holiday",
  leave_type: "Leave type",
  approved_leave: "Leave",
  request: "Request",
  delete_request: "Deletion request",
  manager_assignment: "Manager assignment",
  custom_field: "Custom field",
  branding: "Branding",
  email_config: "Email settings",
  report_schedule: "Report schedule",
  attendance: "Attendance",
  attendance_email_log: "Attendance email",
  clip_pipeline_batch: "Clip batch",
  uploaded_video: "Uploaded video",
  tenant: "Workspace",
  oidc: "Microsoft sign-in",
  google_oidc: "Google sign-in",
  entra_sync: "Azure AD sync",
  entra_group_role_map: "Azure AD role map",
  queue: "Queue",
  capture_manager: "Camera workers",
  pipeline_analytics: "Pipeline analytics",
  audit_log: "Audit log",
};

export const CATEGORY_TEXT: Record<string, string> = {
  security: "Security",
  people: "People",
  attendance: "Attendance",
  devices: "Cameras & devices",
  storage: "Clips & storage",
  reports: "Reports & exports",
  settings: "Settings",
  other: "Other",
};

export const CATEGORY_ORDER = ["security", "people", "attendance", "devices", "storage", "reports", "settings", "other"] as const;

export const SEVERITY_TEXT: Record<string, string> = {
  info: "Info",
  warning: "Warning",
  high: "High risk",
};

const keyOf = (code: string) => code.replace(/\./g, "_");

/** "clip_cleanup.executed" → "Clip cleanup executed". */
export function humanizeCode(code: string): string {
  const words = code.replace(/[._]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
}

export function actionText(t: TFunction, action: string): string {
  return t(`auditLog.act.${keyOf(action)}`, { defaultValue: ACTION_TEXT[action] ?? humanizeCode(action) });
}

export function groupText(t: TFunction, action: string, n: number): string {
  const tpl = GROUP_TEXT[action];
  if (tpl) return t(`auditLog.group.${keyOf(action)}`, { n: n.toLocaleString(), defaultValue: tpl });
  return t("auditLog.group.generic", {
    text: actionText(t, action),
    n: n.toLocaleString(),
    defaultValue: "{{text}} · {{n}} times",
  });
}

export function entityTypeText(t: TFunction, type: string): string {
  return t(`auditLog.entity.${type}`, { defaultValue: ENTITY_TEXT[type] ?? humanizeCode(type) });
}

export function categoryText(t: TFunction, cat: string): string {
  return t(`auditLog.cat.${cat}`, { defaultValue: CATEGORY_TEXT[cat] ?? humanizeCode(cat) });
}

export function severityText(t: TFunction, sev: string): string {
  return t(`auditLog.sev.${sev}`, { defaultValue: SEVERITY_TEXT[sev] ?? sev });
}

// Entity ids that are opaque tokens (session ids) are never shown.
const HIDE_ID_TYPES = new Set(["session", "tenant_settings", "branding", "email_config", "oidc", "google_oidc", "audit_log"]);

/** "Employee Kabilesh" / "Clip #4139" / "Session". */
export function entityText(t: TFunction, e: Pick<AuditEntry, "entity_type" | "entity_id" | "entity_label">): string {
  const type = entityTypeText(t, e.entity_type);
  if (e.entity_label) return `${type} ${e.entity_label}`;
  if (e.entity_id && !HIDE_ID_TYPES.has(e.entity_type) && e.entity_id.length <= 24) return `${type} #${e.entity_id}`;
  return type;
}

const GONE = /(purged|hard_deleted|bulk_deleted|\.deleted$)/;

/** In-app route for the entity, when one exists. */
export function entityHref(e: AuditEntry): string | null {
  const id = e.entity_id;
  switch (e.entity_type) {
    case "employee":
      return id && /^\d+$/.test(id) && !GONE.test(e.action) ? `/employees/${id}` : "/employees";
    case "photo": {
      const emp = (e.after?.["employee_id"] ?? e.before?.["employee_id"]) as unknown;
      return typeof emp === "number" ? `/employees/${emp}` : null;
    }
    case "camera":
      return "/cameras";
    case "device":
      return "/devices";
    case "user":
      return "/settings/users";
    case "person_clip":
    case "person_clips":
      return "/person-clips";
    case "detection_event":
      return "/camera-logs";
    case "department":
      return "/settings/departments";
    case "division":
      return "/settings/divisions";
    case "section":
      return "/settings/sections";
    case "shift_policy":
    case "policy_assignment":
      return "/policies";
    case "holiday":
    case "leave_type":
    case "approved_leave":
      return "/leave-policy";
    case "request":
    case "delete_request":
      return "/approvals";
    case "report":
      return "/reports";
    case "tenant_settings":
      return "/settings/workspace";
    case "branding":
      return "/settings/branding";
    case "email_config":
      return "/settings/email";
    case "report_schedule":
      return "/settings/schedules";
    case "custom_field":
      return "/settings/custom-fields";
    case "manager_assignment":
      return "/mgr-assign";
    case "oidc":
    case "google_oidc":
      return "/settings/authentication";
    default:
      return null;
  }
}
