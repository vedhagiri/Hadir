// Wire types for /api/custom-fields and the per-employee values surface.

export type CustomFieldType = "text" | "number" | "date" | "select";

export const CUSTOM_FIELD_TYPES: CustomFieldType[] = [
  "text",
  "number",
  "date",
  "select",
];

export interface CustomField {
  id: number;
  tenant_id: number;
  name: string;
  code: string;
  type: CustomFieldType;
  options: string[] | null;
  required: boolean;
  display_order: number;
}

export interface CustomFieldCreateInput {
  name: string;
  code: string;
  type: CustomFieldType;
  options?: string[] | null;
  required?: boolean;
}

export interface CustomFieldPatchInput {
  name?: string;
  options?: string[] | null;
  required?: boolean;
  display_order?: number;
}

export interface ReorderItem {
  id: number;
  display_order: number;
}

export interface CustomFieldValue {
  field_id: number;
  code: string;
  name: string;
  type: CustomFieldType;
  value: string | number | null;
  raw: string;
}

export interface CustomFieldValuePatchItem {
  field_id: number;
  value: string | number | null;
}
