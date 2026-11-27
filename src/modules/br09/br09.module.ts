import { Module } from '@nestjs/common';
import { Br09Controller } from './br09.controller';
import { Br09Service } from './br09.service';

@Module({ controllers: [Br09Controller], providers: [Br09Service], exports: [Br09Service] })
export class Br09Module {}
