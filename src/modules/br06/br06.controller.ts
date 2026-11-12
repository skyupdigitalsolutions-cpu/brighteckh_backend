import { Body, Controller, Get, Param, Post, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Br06GrnLineMediaRow, Br06GrnLinesRow, Br06GrnsRow, Br06SalesSourcingAuthorisationsRow, Br06SupplierPurchaseOrdersRow,
} from '../../common/swagger/rows.generated';
import {
  GrnDetail, PurchaseOrderDetail,
} from './dto/br06.responses';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { Br06Service } from './br06.service';
import {
  AcknowledgePoDto, AddGrnLineMediaDto, CreateGrnDto, CreatePoDto, CreateSalesOrderPoDto, CreateSalesSourcingDto,
  PostGrnLineDto, RecordShipmentDto,
} from './dto/br06.dto';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';

interface Actor { id: string; role: string; companyId: string }

@ApiTags('BR-06 Supplier PO & GRN')
@ApiAuth()
@ApiStdErrors()
@Controller()
@UseGuards(RolesGuard)
export class Br06Controller {
  constructor(private readonly svc: Br06Service) {}

  // supplier PO

  @ApiCreatedResponse({ type: PurchaseOrderDetail })
  @Post('jobs/:id/purchase-orders')
  @Roles(Role.PURCHASE)
  createPo(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreatePoDto, @CurrentActor() actor: Actor) {
    return this.svc.createPo(id, dto, actor);
  }

  @Get('jobs/:id/purchase-orders')
  @ApiOperation({ summary: "Supplier POs for the job (headers only), newest first" })
  @ApiOkResponse({ type: [Br06SupplierPurchaseOrdersRow] })
  @Roles(Role.PURCHASE)
  listPos(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.listPos(id, actor);
  }

  @Get('purchase-orders/:id')
  @ApiOperation({ summary: "Supplier PO with lines" })
  @ApiOkResponse({ type: PurchaseOrderDetail })
  @Roles(Role.PURCHASE)
  getPo(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getPo(id, actor);
  }

  @ApiCreatedResponse({ type: Br06SupplierPurchaseOrdersRow })
  @Post('purchase-orders/:id/release')
  @Roles(Role.PURCHASE)
  releasePo(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.releasePo(id, actor);
  }

  @ApiCreatedResponse({ type: Br06SupplierPurchaseOrdersRow })
  @Post('purchase-orders/:id/acknowledge')
  @Roles(Role.PURCHASE)
  acknowledgePo(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AcknowledgePoDto, @CurrentActor() actor: Actor) {
    return this.svc.acknowledgePo(id, dto, actor);
  }

  @ApiCreatedResponse({ type: Br06SupplierPurchaseOrdersRow })
  @Post('purchase-orders/:id/shipment')
  @Roles(Role.PURCHASE)
  recordShipment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordShipmentDto, @CurrentActor() actor: Actor) {
    return this.svc.recordShipment(id, dto, actor);
  }

  // SALES_ORDER purpose (BR-11 product-sale shortages). Supplier cost lives here,
  // so every route is PURCHASE-only: Sales never sees supplier price.

  @Post('sales-order-lines/:id/sourcing-authorisations')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Authorise sourcing for ONE exact Sales Order line (supplier, offer + comparison evidence, rank; MD evidence if non-L1)' })
  @ApiCreatedResponse({ type: Br06SalesSourcingAuthorisationsRow })
  createSalesSourcing(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateSalesSourcingDto, @CurrentActor() actor: Actor) {
    return this.svc.createSalesSourcing(id, dto, actor);
  }

  @Post('sales-sourcing-authorisations/:id/cancel')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Cancel a sourcing authorisation that is not on a live supplier PO' })
  @ApiCreatedResponse({ type: Br06SalesSourcingAuthorisationsRow })
  cancelSalesSourcing(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.cancelSalesSourcing(id, actor);
  }

  @Get('sales-orders/:id/sourcing-authorisations')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Sourcing authorisations for a Sales Order (includes supplier price -- Purchase only)' })
  @ApiOkResponse({ type: [Br06SalesSourcingAuthorisationsRow] })
  listSalesSourcing(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.listSalesSourcing(id, actor);
  }

  @Post('sales-orders/:id/purchase-orders')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Raise a SALES_ORDER supplier PO (same PO series + release/GRN path; no repair Job ID)' })
  @ApiCreatedResponse({ type: PurchaseOrderDetail })
  createSalesOrderPo(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateSalesOrderPoDto, @CurrentActor() actor: Actor) {
    return this.svc.createSalesOrderPo(id, dto, actor);
  }

  @Get('sales-orders/:id/purchase-orders')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'SALES_ORDER supplier POs for a Sales Order (headers), newest first' })
  @ApiOkResponse({ type: [Br06SupplierPurchaseOrdersRow] })
  listSalesOrderPos(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.listSalesOrderPos(id, actor);
  }

  // GRN

  @ApiCreatedResponse({ type: GrnDetail })
  @Post('purchase-orders/:id/grns')
  @Roles(Role.STORES_QUALITY)
  createGrn(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateGrnDto, @CurrentActor() actor: Actor) {
    return this.svc.createGrn(id, dto, actor);
  }

  @Get('purchase-orders/:id/grns')
  @ApiOperation({ summary: "GRNs for the PO (headers only), newest first" })
  @ApiOkResponse({ type: [Br06GrnsRow] })
  @Roles(Role.PURCHASE)
  listGrns(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.listGrns(id, actor);
  }

  @Get('grns/:id')
  @ApiOperation({ summary: "GRN with lines" })
  @ApiOkResponse({ type: GrnDetail })
  getGrn(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getGrn(id, actor);
  }

  @ApiCreatedResponse({ type: Br06GrnLineMediaRow })
  @Post('grn-lines/:id/media')
  @Roles(Role.STORES_QUALITY)
  addGrnLineMedia(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddGrnLineMediaDto, @CurrentActor() actor: Actor) {
    return this.svc.addGrnLineMedia(id, dto, actor);
  }

  @ApiCreatedResponse({ type: Br06GrnLinesRow })
  @Post('grn-lines/:id/post')
  @Roles(Role.STORES_QUALITY)
  postGrnLine(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PostGrnLineDto, @CurrentActor() actor: Actor) {
    return this.svc.postGrnLine(id, dto, actor);
  }

  @ApiCreatedResponse({ type: Br06GrnLinesRow })
  @Post('grn-lines/:id/supplier-return')
  @Roles(Role.PURCHASE)
  initiateSupplierReturn(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.initiateSupplierReturn(id, actor);
  }
}
