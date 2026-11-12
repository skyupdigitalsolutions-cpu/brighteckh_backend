import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { OperationObject, ParameterObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { BEARER_SCHEME } from './common/swagger/api-docs';
import { join } from 'path';
import { AppModule } from './app.module';
import { uploadMaxBytes } from './modules/uploads/uploads.service';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.enableCors({ origin: true });
  // POST /api/uploads (G4): one file per request, size-capped at the parser.
  const fastifyMultipart = (await import('@fastify/multipart')).default;
  await app.register(fastifyMultipart as any, { limits: { fileSize: uploadMaxBytes(), files: 1, fields: 0, parts: 1 } });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.setGlobalPrefix('api');

  const dashboardEnabled =
    process.env.NODE_ENV !== 'production' || process.env.ENABLE_DASHBOARD === 'true';

  if (dashboardEnabled) {
    // Swagger API tester at /api/docs
    const cfg = new DocumentBuilder()
      .setTitle('Brightech JMS API')
      .setDescription('Masters, Inventory ledger, and BR modules')
      .setVersion('0.1')
      .addBearerAuth(
        {
          type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
          description: 'Access token from POST /api/auth/login (or /api/auth/refresh). Role + company are resolved '
            + 'server-side from the employee record when the token is issued -- never from the request body. '
            + "Each operation's `x-roles` extension lists the role(s) allowed to call it.",
        },
        BEARER_SCHEME,
      )
      .addTag('Auth', 'Login, token refresh (rotating), logout, current user')
      .addTag('Masters', 'Item + Assembly master, approval, BOM (F1)')
      .addTag('Inventory ledger', 'Single-writer stock ledger (F2). Every write is idempotent on Idempotency-Key')
      .addTag('BR-02 Inward & Jobs', 'Inward receipt (JIN) → equipment groups → units → Job ID → engineer assignment')
      .addTag('BR-03 Custody, Inspection & Material Requests', 'Engineer custody, timed inspection, versioned report, material requests to Purchase')
      .addTag('BR-04 Stock Check, RFQ & Quotes', 'Stock snapshot, shortages, per-job RFQs, supplier offers, customer quotations')
      .addTag('BR-05 Customer Authority, Authorisation & Reservations', 'Quote responses, PO / Job Order / email authority, job authorisation, release, reservations')
      .addTag('BR-06 Supplier PO & GRN', 'Supplier purchase orders, goods receipt (GRN), supplier returns')
      .addTag('BR-07 Repair, Test & Dispatch', 'Material issue/consume/return, repair sessions + report, test cycles, handoff, dispatch release')
      .addTag('BR-08 Dispatch, Invoicing & Payment', 'Dispatch batch, Job Work Delivery Challan, POD, GST tax invoice, payments (partial), credit notes, no-charge waiver, job closure')
      .addTag('BR-09 After-Sales & Warranty', 'Complaint cases, repeat returns (BR-02 links), technical assessment, configured claim/goodwill approval, credit-note requests to Finance, case closure, quality analytics')
      .addTag('BR-10 Management MIS & RBAC', 'Read-only management reports (company + row scoped, masked, audited) and the R_* role-binding / named-grant permission layer')
      .addTag('Working Calendar', 'Per-company working hours, lunch break, holidays; working-time due-date maths')
      .addTag('Uploads', 'File storage behind every file_uri (photos, videos, PDFs); company-scoped reads')
      .addTag('Health')
      .build();
    SwaggerModule.setup('api/docs', app, tidyHeaderParams(SwaggerModule.createDocument(app, cfg)));

    // Serve the visual dashboard at / from /public
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic as any, { root: join(process.cwd(), 'public'), prefix: '/' });
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`Brightech JMS API on http://localhost:${port}/api`);
  if (dashboardEnabled) {
    console.log(`Dashboard          -> http://localhost:${port}/`);
    console.log(`API tester (Swagger)-> http://localhost:${port}/api/docs`);
  }
}
/**
 * Docs-only cleanup. Inventory controllers read @Headers('idempotency-key'),
 * which Swagger auto-lists as a lowercase param next to the explicitly
 * documented `Idempotency-Key`. Dedupe headers case-insensitively, keeping the
 * documented one.
 */
function tidyHeaderParams(doc: OpenAPIObject): OpenAPIObject {
  for (const pathItem of Object.values(doc.paths)) {
    for (const op of Object.values(pathItem) as OperationObject[]) {
      if (!op?.parameters) continue;
      const params = op.parameters as ParameterObject[];
      const kept: ParameterObject[] = [];
      for (const p of params) {
        if (p.in !== 'header') { kept.push(p); continue; }
        const key = p.name.toLowerCase();
        const dup = kept.findIndex((k) => k.in === 'header' && k.name.toLowerCase() === key);
        if (dup === -1) kept.push(p);
        else if (p.description && !kept[dup].description) kept[dup] = p;
      }
      op.parameters = kept;
    }
  }
  return doc;
}

bootstrap();
