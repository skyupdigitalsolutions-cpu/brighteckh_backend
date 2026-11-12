import { ApiProperty } from '@nestjs/swagger';
import {
  Br10ColumnMasksRow, Br10GrantApprovalsRow, Br10PermissionMatrixRow, Br10ReportCatalogueRow, Br10ReportGrantsRow,
  Br10RoleBindingsRow, Br10RoleCatalogueRow, Br10SalesCustomerAssignmentsRow,
} from '../../../common/swagger/rows.generated';

export class ReadinessItem {
  @ApiProperty() item!: string;
  @ApiProperty({ example: 'PENDING_CONFIG', description: 'Why a metric is null/partial -- never a silent zero' }) status!: string;
  @ApiProperty() note!: string;
}

export class ReportScope {
  @ApiProperty({ type: [String], format: 'uuid' }) company_ids!: string[];
  @ApiProperty({ enum: ['COMPANY', 'CUSTOMERS', 'JOBS', 'SELF'] }) row_scope!: string;
  @ApiProperty({ type: [String], example: ['R_PURCHASE_EXEC'] }) via_roles!: string[];
  @ApiProperty({ description: 'true only with an ACTIVE PII_CUSTOMER VIEW grant on every company in scope; otherwise customer name/GSTIN are masked' })
  pii_unmasked!: boolean;
}

export class ReportResponse {
  @ApiProperty() report_code!: string;
  @ApiProperty() title!: string;
  @ApiProperty() data_class!: string;
  @ApiProperty({ enum: ['DRAFT', 'VALIDATED'] }) kpi_status!: string;
  @ApiProperty({ format: 'date-time' }) as_of!: string;
  @ApiProperty({ type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } }) period!: { from: string; to: string };
  @ApiProperty({ type: ReportScope }) scope!: ReportScope;
  @ApiProperty({ type: 'object', additionalProperties: true }) summary!: Record<string, unknown>;
  @ApiProperty({ type: [ReadinessItem] }) readiness!: ReadinessItem[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' }, description: 'KPI formula definitions (traceability, T16)' })
  formulas!: Record<string, string>;
  @ApiProperty({ type: 'array', items: { type: 'object' }, description: 'Drill-down rows (Job ID level where applicable)' })
  rows!: Record<string, unknown>[];
}

export class Br10Catalogue {
  @ApiProperty({ type: [Br10RoleCatalogueRow] }) roles!: Br10RoleCatalogueRow[];
  @ApiProperty({ type: [Br10PermissionMatrixRow] }) permission_matrix!: Br10PermissionMatrixRow[];
  @ApiProperty({ type: [Br10ReportCatalogueRow] }) reports!: Br10ReportCatalogueRow[];
  @ApiProperty({ type: [Br10ColumnMasksRow] }) column_masks!: Br10ColumnMasksRow[];
}

export class MyAccess {
  @ApiProperty({ type: [Br10RoleBindingsRow] }) bindings!: Br10RoleBindingsRow[];
  @ApiProperty({ type: [Br10ReportGrantsRow] }) grants!: Br10ReportGrantsRow[];
  @ApiProperty({ type: [Br10SalesCustomerAssignmentsRow] }) sales_customer_assignments!: Br10SalesCustomerAssignmentsRow[];
}

export class GrantWithApprovals extends Br10ReportGrantsRow {
  @ApiProperty({ type: [Br10GrantApprovalsRow], nullable: true }) approvals!: Br10GrantApprovalsRow[] | null;
}

export class AuthorityStatus {
  @ApiProperty({ enum: ['FINANCIAL_GRANT', 'CROSS_COMPANY_GRANT'] }) authority_kind!: string;
  @ApiProperty({ type: 'string', nullable: true }) approver_role_code!: string | null;
  @ApiProperty({ example: 'CLIENT-UNCONFIRMED (restricted grants blocked)' }) status!: string;
  @ApiProperty({ type: 'string', nullable: true }) note!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true }) updated_at!: string | null;
}
