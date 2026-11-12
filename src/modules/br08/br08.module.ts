import { Module } from '@nestjs/common';
import { Br08Controller } from './br08.controller';
import { Br08Service } from './br08.service';

@Module({ controllers: [Br08Controller], providers: [Br08Service] })
export class Br08Module {}
