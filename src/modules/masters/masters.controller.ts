import { Body, Controller, Get, Param, Post, Query, ParseUUIDPipe } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { MastersService } from './masters.service';
import { CreateItemDto, CreateAssemblyDto, AddBomLineDto } from './dto/masters.dto';
import {
  FdnAssemblyBomRow, FdnAssemblyMasterRow, FdnItemMasterRow,
} from '../../common/swagger/rows.generated';
import { ApiAuth, ApiStdErrors } from '../../common/swagger/api-docs';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { AuthUser } from '../../common/auth/auth.types';

const STATUS_QUERY = {
  name: 'status', required: false,
  enum: ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'ON_HOLD', 'INACTIVE', 'SUPERSEDED'],
  description: 'Defaults to ACTIVE. Max 50 rows.',
};

@ApiTags('Masters')
@ApiAuth()
@ApiStdErrors()
@Controller('masters')
export class MastersController {
  constructor(private readonly svc: MastersService) {}

  @ApiCreatedResponse({ type: FdnItemMasterRow })
  @Post('items') createItem(@Body() dto: CreateItemDto, @CurrentActor() actor: AuthUser) {
    return this.svc.createItem(dto, actor.id);
  }
  @ApiCreatedResponse({ type: FdnItemMasterRow })
  @Post('items/:id/approve') approveItem(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: AuthUser) {
    return this.svc.approveItem(id, actor.id);
  }
  @ApiOperation({ summary: 'List items by status (ordered by item_code), optionally searched' })
  @ApiQuery(STATUS_QUERY)
  @ApiQuery({
    name: 'search', required: false,
    description: 'Case-insensitive substring of item_code, standard_name or short_description (max 100 chars)',
  })
  @ApiOkResponse({ type: [FdnItemMasterRow] })
  @Get('items') listItems(@Query('status') s?: string, @Query('search') search?: string) {
    return this.svc.listItems(s ?? 'ACTIVE', 50, search);
  }

  @ApiOperation({ summary: 'Item detail' })
  @ApiOkResponse({ type: FdnItemMasterRow })
  @Get('items/:id') getItem(@Param('id', ParseUUIDPipe) id: string) { return this.svc.getItem(id); }

  @ApiCreatedResponse({ type: FdnAssemblyMasterRow })
  @Post('assemblies') createAssembly(@Body() dto: CreateAssemblyDto, @CurrentActor() actor: AuthUser) {
    return this.svc.createAssembly(dto, actor.id);
  }
  @ApiCreatedResponse({ type: FdnAssemblyMasterRow })
  @Post('assemblies/:id/approve') approveAssembly(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: AuthUser) {
    return this.svc.approveAssembly(id, actor.id);
  }
  @ApiCreatedResponse({ type: FdnAssemblyBomRow })
  @Post('assemblies/:id/bom') addBom(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddBomLineDto) {
    return this.svc.addBomLine(id, dto);
  }
  @ApiOperation({ summary: 'List assemblies by status (ordered by assembly_code)' })
  @ApiQuery(STATUS_QUERY)
  @ApiOkResponse({ type: [FdnAssemblyMasterRow] })
  @Get('assemblies') listAssemblies(@Query('status') s?: string) { return this.svc.listAssemblies(s ?? 'ACTIVE'); }
}
