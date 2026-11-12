import { ApiProperty } from '@nestjs/swagger';

export class LocationBalance {
  @ApiProperty({
    enum: ['MAIN_STORE', 'QUARANTINE', 'ENGINEER_HELD', 'IN_TRANSIT', 'RETURNED', 'CONSUMED', 'SUPPLIER_RETURN'],
    description: 'Location role (fdn_inventory_locations.role)',
  })
  role!: string;
  @ApiProperty({ description: 'Location code (unique per company)' }) code!: string;
  @ApiProperty({ type: 'string', format: 'decimal', description: 'numeric, returned as decimal string' })
  qty_on_hand!: string;
}

export class InventoryAvailabilityResponse {
  @ApiProperty({ format: 'uuid' }) company_id!: string;
  @ApiProperty({ format: 'uuid' }) item_id!: string;
  @ApiProperty({ type: 'number', description: 'fdn_allocatable(): on-hand minus active reservations' })
  allocatable!: number;
  @ApiProperty({ type: [LocationBalance] }) balances!: LocationBalance[];
}

/** POST /inventory/reservations */
export class InventoryReservationResponse {
  @ApiProperty({ format: 'uuid', description: 'fdn_inventory_reservations.id' }) reservation_id!: string;
  @ApiProperty({ enum: ['ACTIVE'] }) status!: string;
  @ApiProperty({ type: 'number', description: 'Allocatable qty after the reservation' }) allocatable_after!: number;
}

/** POST receipts / issues / consumptions / returns / supplier-returns */
export class InventoryPostingResponse {
  @ApiProperty({ format: 'uuid', description: 'fdn_inventory_journal.id of the posting' }) transaction_id!: string;
  @ApiProperty({ enum: ['POSTED'] }) status!: string;
  @ApiProperty({ type: 'number', description: 'Allocatable qty after the movement' }) available_after!: number;
  @ApiProperty({ type: InventoryAvailabilityResponse }) version!: InventoryAvailabilityResponse;
}
