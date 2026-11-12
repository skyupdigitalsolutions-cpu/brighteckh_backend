import { Controller, Get, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import {
  ApiBody, ApiConsumes, ApiCreatedResponse, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiPayloadTooLargeResponse,
  ApiProperty, ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiAuth, ApiStdErrors, ErrorResponse } from '../../common/swagger/api-docs';
import { CurrentActor } from '../../common/auth/current-actor.decorator';
import { AuthUser } from '../../common/auth/auth.types';
import { UPLOAD_TYPES, UploadsService } from './uploads.service';

/** POST /uploads response: file_uploads row (minus the internal storage key) + the file_uri to use. */
export class UploadResult {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) company_id!: string;
  @ApiProperty({ format: 'uuid' }) uploaded_by_id!: string;
  @ApiProperty({ description: 'Original file name (path and control characters removed)' }) original_name!: string;
  @ApiProperty({ enum: Object.keys(UPLOAD_TYPES) }) content_type!: string;
  @ApiProperty({ description: 'bigint, returned as string', example: '183422' }) size_bytes!: string;
  @ApiProperty({ description: 'SHA-256 of the stored bytes (hex)' }) sha256!: string;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
  @ApiProperty({
    example: '/api/uploads/0b9f…',
    description: 'Pass this as `file_uri` to the media/photo endpoints. GET it (with the bearer token) to read the bytes.',
  })
  file_uri!: string;
}

@ApiTags('Uploads')
@ApiAuth()
@ApiStdErrors()
@Controller('uploads')
export class UploadsController {
  constructor(private readonly svc: UploadsService) {}

  @Post()
  @ApiOperation({
    summary: 'Upload one file (photo / video / PDF); returns the file_uri to attach to a record',
    description: `multipart/form-data with a single field "file". Allowed types: ${Object.keys(UPLOAD_TYPES).join(', ')}. `
      + 'The declared type must match the file content. Size limit: UPLOAD_MAX_BYTES (default 25 MB). Any authenticated role; '
      + "the file is filed under the caller's company.",
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiCreatedResponse({ type: UploadResult })
  @ApiPayloadTooLargeResponse({ description: 'File larger than UPLOAD_MAX_BYTES', type: ErrorResponse })
  upload(@Req() req: FastifyRequest, @CurrentActor() actor: AuthUser) {
    return this.svc.upload(req, actor);
  }

  @Get(':id')
  @ApiOperation({ summary: "Download an uploaded file's bytes (caller's company only)" })
  @ApiOkResponse({ description: 'The file, with its stored Content-Type', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } })
  @ApiForbiddenResponse({ description: 'Upload belongs to another company', type: ErrorResponse })
  async download(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: AuthUser, @Res() reply: FastifyReply) {
    const { row, stream } = await this.svc.open(id, actor);
    const name = encodeURIComponent(row.original_name);
    return reply
      .header('Content-Type', row.content_type)
      .header('Content-Length', String(row.size_bytes))
      .header('Content-Disposition', `inline; filename*=UTF-8''${name}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=3600')
      .header('ETag', `"${row.sha256}"`)
      .send(stream());
  }
}
