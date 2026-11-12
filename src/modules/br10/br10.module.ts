import { Module } from '@nestjs/common';
import { Br10AccessService } from './br10-access.service';
import { Br10Controller } from './br10.controller';
import { Br10Service } from './br10.service';

@Module({ controllers: [Br10Controller], providers: [Br10Service, Br10AccessService] })
export class Br10Module {}
