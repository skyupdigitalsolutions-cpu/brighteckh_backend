import { Body, Controller, Get, Param, Post, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  EquipmentPhotosRow, InwardEquipmentGroupsRow, InwardReceiptsRow, JobAssignmentsRow, JobRepeatLinksRow,
} from '../../common/swagger/rows.generated';
import {
  ExpandGroupResponse, InwardReceiptDetail, JobDetail, MyJobRow, VerifyUnitResponse,
} from './dto/br02.responses';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { Br02Service } from './br02.service';
import {
  AddUnitPhotoDto, AssignEngineerDto, CreateEquipmentGroupDto, CreateInwardReceiptDto,
  ExpandEquipmentGroupDto, LinkRepeatJobDto, MyJobsQueryDto,
} from './dto/br02.dto';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/roles.enum';
import { CurrentActor } from '../../common/auth/current-actor.decorator';

interface Actor { id: string; role: string; companyId: string }

@ApiTags('BR-02 Inward & Jobs')
@ApiAuth()
@ApiStdErrors()
@Controller()
@UseGuards(RolesGuard)
export class Br02Controller {
  constructor(private readonly svc: Br02Service) {}

  @ApiCreatedResponse({ type: InwardReceiptsRow })
  @Post('inward-receipts')
  @Roles(Role.PURCHASE)
  createReceipt(@Body() dto: CreateInwardReceiptDto, @CurrentActor() actor: Actor) {
    return this.svc.createInwardReceipt(dto, actor);
  }

  @Get('inward-receipts/:id')
  @ApiOperation({ summary: "JIN detail with equipment groups and units" })
  @ApiOkResponse({ type: InwardReceiptDetail })
  getReceipt(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getInwardReceipt(id, actor);
  }

  @ApiCreatedResponse({ type: InwardEquipmentGroupsRow })
  @Post('inward-receipts/:id/equipment-groups')
  @Roles(Role.PURCHASE)
  addGroup(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateEquipmentGroupDto, @CurrentActor() actor: Actor) {
    return this.svc.addEquipmentGroup(id, dto, actor);
  }

  @ApiCreatedResponse({ type: ExpandGroupResponse })
  @Post('equipment-groups/:id/expand')
  @Roles(Role.PURCHASE)
  expand(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ExpandEquipmentGroupDto, @CurrentActor() actor: Actor) {
    return this.svc.expandGroup(id, dto, actor);
  }

  @ApiCreatedResponse({ type: EquipmentPhotosRow })
  @Post('equipment-units/:id/photos')
  @Roles(Role.PURCHASE)
  addPhoto(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddUnitPhotoDto, @CurrentActor() actor: Actor) {
    return this.svc.addUnitPhoto(id, dto, actor);
  }

  @ApiCreatedResponse({ type: VerifyUnitResponse })
  @Post('equipment-units/:id/verify')
  @Roles(Role.PURCHASE)
  verify(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.verifyUnit(id, actor);
  }

  @Get('my-jobs')
  @Roles(Role.ENGINEER)
  @ApiOperation({
    summary: "The caller's jobs: current engineer assignment is the caller (incl. PENDING custody)",
    description: 'Ordered CRITICAL -> URGENT -> NORMAL, then newest first. Max 500 rows.',
  })
  @ApiOkResponse({ type: [MyJobRow] })
  myJobs(@Query() q: MyJobsQueryDto, @CurrentActor() actor: Actor) {
    return this.svc.listMyJobs(actor, q.status);
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: "Job detail with current engineer assignment" })
  @ApiOkResponse({ type: JobDetail })
  getJob(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.getJob(id, actor);
  }

  @ApiCreatedResponse({ type: JobAssignmentsRow })
  @Post('jobs/:id/assign')
  @Roles(Role.PURCHASE)
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignEngineerDto, @CurrentActor() actor: Actor) {
    return this.svc.assignEngineer(id, dto, actor);
  }

  @ApiCreatedResponse({ type: JobRepeatLinksRow })
  @Post('jobs/:id/repeat-link')
  @Roles(Role.PURCHASE)
  @ApiOperation({ summary: 'Warranty return: link this NEW job (new JIN) to the job it repeats (R01/R02..., DB-assigned)' })
  linkRepeat(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkRepeatJobDto, @CurrentActor() actor: Actor) {
    return this.svc.linkRepeatJob(id, dto, actor);
  }
}
