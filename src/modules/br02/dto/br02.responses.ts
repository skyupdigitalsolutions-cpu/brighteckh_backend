import { ApiProperty } from '@nestjs/swagger';
import {
  InwardEquipmentGroupsRow, InwardEquipmentUnitsRow, InwardReceiptsRow, JobAssignmentsRow, ServiceJobsRow,
} from '../../../common/swagger/rows.generated';

/** GET /inward-receipts/:id — JIN header with all groups and expanded units. */
export class InwardReceiptDetail extends InwardReceiptsRow {
  @ApiProperty({ type: [InwardEquipmentGroupsRow], description: 'Ordered by group_number' })
  equipment_groups!: InwardEquipmentGroupsRow[];
  @ApiProperty({ type: [InwardEquipmentUnitsRow], description: 'Ordered by group_id, unit_number' })
  equipment_units!: InwardEquipmentUnitsRow[];
}

/** GET /jobs/:id — service job with its current engineer assignment. */
export class JobDetail extends ServiceJobsRow {
  @ApiProperty({ type: JobAssignmentsRow, nullable: true, description: 'Current assignment, null if unassigned' })
  current_assignment!: JobAssignmentsRow | null;
}

/** POST /equipment-groups/:id/expand */
export class ExpandGroupResponse {
  @ApiProperty({ type: 'integer', description: 'Units created by br02_expand_equipment_group()' })
  quantity_expanded!: number;
  @ApiProperty({ type: [InwardEquipmentUnitsRow], description: "All of the group's units, ordered by unit_number" })
  units!: InwardEquipmentUnitsRow[];
}

/** POST /equipment-units/:id/verify — the unit is verified and its Job ID allocated in one transaction. */
export class VerifyUnitResponse {
  @ApiProperty({ type: InwardEquipmentUnitsRow }) equipment_unit!: InwardEquipmentUnitsRow;
  @ApiProperty({ type: ServiceJobsRow, description: 'The newly created job (job_number allocated by the DB counter)' })
  job!: ServiceJobsRow;
}

/**
 * GET /my-jobs (G1) -- one row per job whose CURRENT assignment is the caller, with the context a job
 * list needs (JIN, unit position, equipment) so the client doesn't fan out to other endpoints.
 */
export class MyJobRow extends ServiceJobsRow {
  @ApiProperty({ type: JobAssignmentsRow, description: "The caller's current assignment on this job" })
  current_assignment!: JobAssignmentsRow;
  @ApiProperty() jin_number!: string;
  @ApiProperty({ description: 'Unit number within its equipment group' }) unit_number!: number;
  @ApiProperty({ description: 'Number of units in that equipment group' }) units_in_group!: number;
  @ApiProperty({ nullable: true, type: 'string' }) serial_number!: string | null;
  @ApiProperty({ nullable: true, type: 'string' }) observed_make!: string | null;
  @ApiProperty({ nullable: true, type: 'string' }) observed_model!: string | null;
  @ApiProperty({ format: 'uuid', description: 'assemblies.id (customer equipment master)' }) assembly_id!: string;
  @ApiProperty() assembly_code!: string;
  @ApiProperty() assembly_name!: string;
}
