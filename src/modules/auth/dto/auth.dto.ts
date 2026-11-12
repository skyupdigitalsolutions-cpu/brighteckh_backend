import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'DEMO-PUR', description: 'employee_code (or the login_id assigned to the employee), case-insensitive' })
  @IsString() @IsNotEmpty() @MaxLength(120)
  login_id!: string;

  @ApiProperty({ format: 'password', description: 'Never logged or stored; compared against the bcrypt hash' })
  @IsString() @IsNotEmpty() @MaxLength(200)
  password!: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'Opaque refresh token from /auth/login or the previous /auth/refresh (single use)' })
  @IsString() @Length(20, 200)
  refresh_token!: string;
}
