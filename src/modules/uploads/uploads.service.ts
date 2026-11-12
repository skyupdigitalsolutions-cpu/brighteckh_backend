import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException, PayloadTooLargeException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, stat, unlink, writeFile } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import type { FastifyRequest } from 'fastify';
import '@fastify/multipart'; // augments FastifyRequest with isMultipart() / file()
import { PgService } from '../../common/database/pg.service';
import { AuthUser } from '../../common/auth/auth.types';

/** Accepted content types -> stored extension. SVG/HTML are deliberately absent (script-capable). */
export const UPLOAD_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
};

export const uploadMaxBytes = () => {
  const n = Number(process.env.UPLOAD_MAX_BYTES ?? 25 * 1024 * 1024);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25 * 1024 * 1024;
};
const uploadRoot = () => resolve(process.env.UPLOAD_DIR || join(process.cwd(), 'storage', 'uploads'));

/**
 * Content sniffing: the declared type must match the bytes, so a renamed HTML/SVG/script can't be stored
 * as an "image" and later served back. Returns true when `buf` plausibly is `type`.
 */
function bytesMatch(type: string, buf: Buffer): boolean {
  const at = (i: number, s: string) => buf.subarray(i, i + s.length).toString('latin1') === s;
  const ftypBrand = at(4, 'ftyp') ? buf.subarray(8, 12).toString('latin1') : null;
  switch (type) {
    case 'image/jpeg': return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/png': return at(0, '\x89PNG\r\n\x1a\n');
    case 'image/webp': return at(0, 'RIFF') && at(8, 'WEBP');
    case 'image/heic':
    case 'image/heif': return !!ftypBrand && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'].includes(ftypBrand);
    case 'video/mp4':
    case 'video/quicktime': return !!ftypBrand; // ISO-BMFF / QuickTime container
    case 'application/pdf': return at(0, '%PDF-');
    default: return false;
  }
}

/** Keep a readable original name: no path, no control chars, ≤255 chars. */
function cleanName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 255);
  return cleaned || 'upload';
}

/** Public shape (storage_key is internal and never returned). */
function publicRow(r: Record<string, unknown>) {
  const { storage_key: _omit, ...rest } = r;
  return { ...rest, file_uri: `/api/uploads/${r.id}` };
}

/**
 * G4: file storage behind every `file_uri`. Bytes go to UPLOAD_DIR/<company>/<yyyy>/<mm>/<uuid><ext>;
 * metadata (+ SHA-256) to file_uploads (append-only, migration 022). Reads are company-scoped.
 * The returned file_uri (`/api/uploads/<id>`) is what the media/photo endpoints should be given.
 */
@Injectable()
export class UploadsService {
  constructor(private readonly pg: PgService) {}

  async upload(req: FastifyRequest, actor: AuthUser) {
    if (!req.isMultipart()) throw new BadRequestException('send multipart/form-data with one "file" field');

    let part;
    try {
      part = await req.file();
    } catch (e) {
      throw new BadRequestException(`invalid multipart body: ${(e as Error).message}`);
    }
    if (!part) throw new BadRequestException('no file in the request (field name "file")');
    if (part.fieldname !== 'file') throw new BadRequestException('the file field must be named "file"');

    const type = (part.mimetype ?? '').toLowerCase();
    const ext = UPLOAD_TYPES[type];
    if (!ext) {
      part.file.resume(); // drain
      throw new BadRequestException(`unsupported file type "${type}"; allowed: ${Object.keys(UPLOAD_TYPES).join(', ')}`);
    }

    let buf: Buffer;
    try {
      buf = await part.toBuffer();
    } catch (e) {
      if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new PayloadTooLargeException(`file exceeds the ${uploadMaxBytes()} byte limit`);
      }
      throw new BadRequestException(`could not read the file: ${(e as Error).message}`);
    }
    if (part.file.truncated) throw new PayloadTooLargeException(`file exceeds the ${uploadMaxBytes()} byte limit`);
    if (buf.length === 0) throw new BadRequestException('the file is empty');
    if (!bytesMatch(type, buf)) throw new BadRequestException(`file content does not match its declared type "${type}"`);

    const id = randomUUID();
    const now = new Date();
    const storageKey = [actor.companyId, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), `${id}${ext}`].join('/');
    const fullPath = join(uploadRoot(), ...storageKey.split('/'));
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, buf, { flag: 'wx' });

    try {
      return await this.pg.tx(async (client) => {
        const r = await client.query(
          `INSERT INTO file_uploads(id,company_id,uploaded_by_id,original_name,content_type,size_bytes,sha256,storage_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [id, actor.companyId, actor.id, cleanName(part.filename), type, buf.length,
            createHash('sha256').update(buf).digest('hex'), storageKey],
        );
        await client.query(
          `INSERT INTO activity_audit_log(company_id,actor_id,entity_table,entity_id,action,before_state,after_state)
           VALUES ($1,$2,'file_uploads',$3,'FILE_UPLOADED',NULL,$4)`,
          [actor.companyId, actor.id, id, publicRow(r.rows[0])],
        );
        return publicRow(r.rows[0]);
      });
    } catch (e) {
      await unlink(fullPath).catch(() => undefined); // no orphan bytes without a metadata row
      throw new BadRequestException((e as Error).message);
    }
  }

  /** Metadata + an absolute path for streaming, after the company check. */
  async open(id: string, actor: AuthUser) {
    const r = await this.pg.query(`SELECT * FROM file_uploads WHERE id=$1`, [id]);
    const row = r.rows[0];
    if (!row) throw new NotFoundException('upload not found');
    if (row.company_id !== actor.companyId) throw new ForbiddenException('upload belongs to another company');

    const root = uploadRoot();
    const fullPath = resolve(root, ...String(row.storage_key).split('/'));
    const rel = relative(root, fullPath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new NotFoundException('upload not found');
    try {
      await stat(fullPath);
    } catch {
      throw new NotFoundException('upload metadata exists but the file is missing from storage');
    }
    return { row, stream: () => createReadStream(fullPath) };
  }
}
