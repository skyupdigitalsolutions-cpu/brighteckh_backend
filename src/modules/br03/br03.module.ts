import { Module } from '@nestjs/common';
import { Br03Controller } from './br03.controller';
import { Br03Service } from './br03.service';

@Module({ controllers: [Br03Controller], providers: [Br03Service] })
export class Br03Module {}
