import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsISO8601, IsOptional, Matches } from 'class-validator';
import { PageQueryDto } from './purchase-desk.dto';
import { PageMeta } from './purchase-desk.responses';

/**
 * Sales stage of a quote, derived from its LATEST revision (see SalesQuotesService.STAGE_SQL and CLAUDE.md §4i
 * "Sales desk reads"). Not stored anywhere.
 */
export const SALES_STAGES = ['TO_SEND', 'AWAITING', 'IN_DISCUSSION', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;
export type SalesStage = (typeof SALES_STAGES)[number];

/** BR-05 br05_customer_response_events CHECK values (migration 001). */
export const RESPONSE_TYPES = [
  'AWAITING_RESPONSE', 'ACCEPTED', 'COUNTER_OFFER', 'TECHNICAL_QUERY', 'PARTIAL_ACCEPTANCE', 'ON_HOLD', 'REJECTED', 'EXPIRED',
];
export const RESPONSE_CHANNELS = ['EMAIL', 'WHATSAPP', 'CALL', 'IN_PERSON', 'OTHER'];

const STAGE_DOC =
  'TO_SEND = latest revision RELEASED_TO_SALES. '
  + 'AWAITING = latest revision SENT and no BR-05 response for it yet, or its latest response is AWAITING_RESPONSE. '
  + 'IN_DISCUSSION = SENT and latest response COUNTER_OFFER / TECHNICAL_QUERY / PARTIAL_ACCEPTANCE / ON_HOLD. '
  + 'ACCEPTED / REJECTED / EXPIRED = SENT and latest response of that type, or the BR-04 revision itself has that '
  + 'quote_status (unreachable today: no API sets those and the DB refuses any update of a SENT revision; the BR-04 status '
  + 'would win over responses).';

export class SalesQuoteListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    type: String,
    description: `Derived sales stage (comma-separated; one or more of ${SALES_STAGES.join(', ')}). Omitted = all. ${STAGE_DOC}`,
    example: 'TO_SEND,AWAITING',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
    return parts.map((s) => s.trim()).filter(Boolean);
  })
  @IsArray() @ArrayMaxSize(6) @IsIn(SALES_STAGES as unknown as string[], { each: true })
  stage?: string[];

  @ApiPropertyOptional({
    example: '2026-12-01',
    description: 'Only quotes whose latest revision valid_until is strictly before this date (YYYY-MM-DD). '
      + 'Quotes with no valid_until are excluded when this is set.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'valid_until_before must be YYYY-MM-DD' })
  @IsISO8601({ strict: true }, { message: 'valid_until_before must be a real date' })
  valid_until_before?: string;
}

// ---------------------------------------------------------------- response

const nullableStr = (description?: string, format?: string) =>
  ApiProperty({ type: 'string', nullable: true, description, ...(format ? { format } : {}) });

export class SalesQuoteLatestResponse {
  @ApiProperty({ format: 'uuid', description: 'br05_customer_response_events.id' }) response_id!: string;
  @ApiProperty({ enum: RESPONSE_TYPES }) response_type!: string;
  @ApiProperty({ type: 'string', nullable: true, enum: RESPONSE_CHANNELS }) response_channel!: string | null;
  @nullableStr('br05_customer_response_events.customer_contact (free text, the customer person contacted)') customer_contact!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) responded_at!: string;
  @ApiProperty({ format: 'uuid' }) recorded_by_id!: string;
  @ApiProperty({ description: 'employees.full_name of recorded_by_id' }) recorded_by_name!: string;
}

/** One quote in the caller's Sales scope. Customer-facing fields only: no offer/estimate/cost ids, no supplier price. */
export class SalesQuoteRow {
  @ApiProperty({ format: 'uuid', description: 'br04_customer_quotes.id (GET /quotes/:id, POST /quotes/:id/send)' }) quote_id!: string;
  @ApiProperty() quote_number!: string;
  @ApiProperty({ enum: ['ITEM', 'ASSEMBLED'] }) quote_type!: string;
  @ApiProperty({ format: 'uuid' }) job_id!: string;
  @ApiProperty() job_number!: string;

  @ApiProperty({ format: 'uuid' }) customer_id!: string;
  @ApiProperty() customer_name!: string;
  @ApiProperty() customer_code!: string;

  @nullableStr() serial_number!: string | null;
  @nullableStr() observed_make!: string | null;
  @nullableStr() observed_model!: string | null;
  @nullableStr('assemblies.assembly_name of the unit\'s equipment group (shared assemblies table)') assembly_name!: string | null;

  @ApiProperty({ format: 'uuid', description: 'BR-04 br04_customer_quote_revisions.id of the LATEST revision (POST /jobs/:id/quote-responses takes this)' })
  latest_revision_id!: string;
  @ApiProperty({ type: 'integer', description: '0-based, as stored' }) revision_no!: number;
  @ApiProperty({ enum: ['RELEASED_TO_SALES', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'], description: 'BR-04 quote_status of the latest revision' })
  quote_status!: string;
  @ApiProperty({ type: 'string', format: 'date', nullable: true }) valid_until!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal', nullable: true, description: 'Latest revision revised_pre_tax (customer price, rupees numeric)' })
  revised_pre_tax!: string | null;
  @ApiProperty({ type: 'string', format: 'decimal', nullable: true }) tax_total!: string | null;
  @ApiProperty({ type: 'string', format: 'decimal', nullable: true }) freight_charge!: string | null;

  @ApiProperty({ format: 'uuid', description: 'br04_quote_sales_handoffs.assigned_sales_id (always the caller)' }) assigned_sales_id!: string;
  @ApiProperty({ type: 'string', format: 'date-time', description: 'br04_quote_sales_handoffs.released_at' }) released_to_sales_at!: string;
  @ApiProperty({ format: 'uuid', description: 'br04_quote_sales_handoffs.released_by_purchase_id' }) released_by_id!: string;
  @ApiProperty({ description: 'employees.full_name of released_by_id' }) released_by_name!: string;

  @nullableStr('changed_at of the BR04_QUOTE_SENT activity_audit_log row for the latest revision; null if not sent', 'date-time')
  sent_at!: string | null;
  @nullableStr('actor_id of that audit row', 'uuid') sent_by_id!: string | null;
  @nullableStr('employees.full_name of sent_by_id') sent_by_name!: string | null;

  @ApiProperty({
    type: SalesQuoteLatestResponse, nullable: true,
    description: 'Newest br05_customer_response_events row recorded against the latest BR-04 revision (via br05_quote_revision_refs.source_br04_quote_id); null if none',
  })
  latest_response!: SalesQuoteLatestResponse | null;

  @ApiProperty({ enum: SALES_STAGES, description: STAGE_DOC }) sales_stage!: SalesStage;
}

export class SalesStageCounts {
  @ApiProperty({ type: 'integer' }) TO_SEND!: number;
  @ApiProperty({ type: 'integer' }) AWAITING!: number;
  @ApiProperty({ type: 'integer' }) IN_DISCUSSION!: number;
  @ApiProperty({ type: 'integer' }) ACCEPTED!: number;
  @ApiProperty({ type: 'integer' }) REJECTED!: number;
  @ApiProperty({ type: 'integer' }) EXPIRED!: number;
}

export class SalesQuoteListPage extends PageMeta {
  @ApiProperty({
    type: [SalesQuoteRow],
    description: 'TO_SEND first by released_to_sales_at ascending (oldest waiting first); then the rest by the latest of '
      + 'sent_at / latest_response.responded_at descending; quote_number breaks ties.',
  })
  rows!: SalesQuoteRow[];

  @ApiProperty({
    type: SalesStageCounts,
    description: 'Per-stage totals for the caller\'s scope under the current `search` only (ignores `stage` and `valid_until_before`). '
      + 'Every stage is present (0 when empty).',
  })
  counts_by_stage!: SalesStageCounts;
}
