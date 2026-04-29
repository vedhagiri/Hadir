// Wire types for /api/manager-assignments — mirrors the Pydantic
// shapes in maugood/manager_assignments/schemas.py.

export interface EmployeeChip {
  employee_id: number;
  employee_code: string;
  full_name: string;
  department_id: number;
  department_code: string;
  department_name: string;
  is_primary: boolean;
  // null on the unassigned column where there's no row yet.
  assignment_id: number | null;
}

export interface ManagerGroup {
  manager_user_id: number;
  full_name: string;
  email: string;
  department_codes: string[];
  employees: EmployeeChip[];
}

export interface AssignmentsListResponse {
  managers: ManagerGroup[];
  unassigned: EmployeeChip[];
}

export interface AssignmentResponse {
  id: number;
  tenant_id: number;
  manager_user_id: number;
  employee_id: number;
  is_primary: boolean;
}
