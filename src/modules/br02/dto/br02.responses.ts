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
