import { Module } from '@nestjs/common';
import { Br02Controller } from './br02.controller';
import { Br02Service } from './br02.service';

@Module({ controllers: [Br02Controller], providers: [Br02Service] })
export class Br02Module {}
