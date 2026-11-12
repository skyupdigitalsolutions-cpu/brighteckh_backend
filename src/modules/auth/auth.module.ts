import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const secret = cfg.get<string>('JWT_SECRET');
        if (!secret || secret.length < 32) {
          throw new Error('JWT_SECRET must be set to a random string of at least 32 characters (see .env.example)');
        }
        return { secret, signOptions: { algorithm: 'HS256' }, verifyOptions: { algorithms: ['HS256'] } };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Global guards run in this order:
    // 1) every route needs a valid access token unless marked @Public();
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // 2) a body/query company_id must equal the token's company (else 403).
    { provide: APP_GUARD, useClass: CompanyScopeGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
