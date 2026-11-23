import { Body, Controller, Get, Headers, Post, Query, BadRequestException, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InventoryService } from './inventory.service';
import { ReceiptDto, InventoryReserveDto, IssueDto, ConsumeDto, ReturnDto, SupplierReturnDto } from './dto/inventory.dto';
import {
  InventoryAvailabilityResponse, InventoryPostingResponse, InventoryReservationResponse,
} from './dto/inventory.responses';
import { FdnInventoryJournalRow } from '../../common/swagger/rows.generated';
import { ApiAuth, ApiIdempotencyKey, ApiStdErrors, ErrorResponse } from '../../common/swagger/api-docs';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { AuthUser } from '../../common/auth/auth.types';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';

@ApiTags('Inventory ledger')
@ApiAuth()
@ApiStdErrors()
@ApiForbiddenResponse({ description: 'company_id (body or query) is not the company of the authenticated user', type: ErrorResponse })
@Controller('inventory')
// Stock-movement writes are PURCHASE-only (CLAUDE.md rule 3; security fix 19 Nov 2026 — no role check before).
// BR-06 / BR-07 / BR-11 post through InventoryService in-process, not through these routes. Reads stay open.
@UseGuards(RolesGuard)
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Get('availability')
  @ApiOperation({ summary: 'Allocatable qty + per-location balances for one item' })
  @ApiQuery({ name: 'company_id', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'item_id', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ type: InventoryAvailabilityResponse })
  availability(@Query('company_id') c: string, @Query('item_id') i: string) {
    if (!c || !i) throw new BadRequestException('company_id and item_id required');
    return this.svc.availability(c, i);
  }

  @Roles(Role.PURCHASE)
  @Post('receipts')
  @ApiIdempotencyKey() @ApiCreatedResponse({ type: InventoryPostingResponse })
  receipt(@Body() d: ReceiptDto, @Headers('idempotency-key') k: string, @CurrentActor() actor: AuthUser) {
    return this.svc.receipt(d, k, actor.id);
  }
  @ApiCreatedResponse({ type: InventoryReservationResponse })
  @Roles(Role.PURCHASE)
  @Post('reservations')
  @ApiIdempotencyKey()
  reserve(@Body() d: InventoryReserveDto, @Headers('idempotency-key') k: string, @CurrentActor() actor: AuthUser) {
    return this.svc.reserve(d, k, actor.id);
  }
  @Roles(Role.PURCHASE)
  @Post('issues')
  @ApiIdempotencyKey() @ApiCreatedResponse({ type: InventoryPostingResponse })
  issue(@Body() d: IssueDto, @Headers('idempotency-key') k: string, @CurrentActor() actor: AuthUser) {
    return this.svc.issue(d, k, actor.id);
  }
  @Roles(Role.PURCHASE)
  @Post('consumptions')
  @ApiIdempotencyKey() @ApiCreatedResponse({ type: InventoryPostingResponse })
  consume(@Body() d: ConsumeDto, @Headers('idempotency-key') k: string, @CurrentActor() actor: AuthUser) {
    return this.svc.consume(d, k, actor.id);
  }
  @Roles(Role.PURCHASE)
  @Post('returns')
  @ApiIdempotencyKey() @ApiCreatedResponse({ type: InventoryPostingResponse })
  ret(@Body() d: ReturnDto, @Headers('idempotency-key') k: string, @CurrentActor() actor: AuthUser) {
    return this.svc.returnMaterial(d, k, actor.id);
  }
  @Roles(Role.PURCHASE)
  @Post('supplier-returns')
  @ApiIdempotencyKey() @ApiCreatedResponse({ type: InventoryPostingResponse })
  supReturn(@Body() d: SupplierReturnDto, @Headers('idempotency-key') k: string, @CurrentActor() actor: AuthUser) {
    return this.svc.supplierReturn(d, k, actor.id);
  }

  @Get('journal')
  @ApiOperation({ summary: 'Ledger journal: all postings for a reference, or the latest 100 for the company' })
  @ApiQuery({ name: 'company_id', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'reference_id', required: false, schema: { type: 'string', format: 'uuid' }, description: 'Omit for latest 100 (newest first); with it, ordered oldest first' })
  @ApiOkResponse({ type: [FdnInventoryJournalRow] })
  journal(@Query('company_id') c: string, @Query('reference_id') r?: string) {
    if (!c) throw new BadRequestException('company_id required');
    return this.svc.journal(c, r);
  }
}
