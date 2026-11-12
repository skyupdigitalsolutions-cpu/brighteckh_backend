import { Module } from '@nestjs/common';
import { Br06Controller } from './br06.controller';
import { Br06Service } from './br06.service';
import { InventoryModule } from '../inventory/inventory.module';

@Module({ imports: [InventoryModule], controllers: [Br06Controller], providers: [Br06Service] })
export class Br06Module {}
