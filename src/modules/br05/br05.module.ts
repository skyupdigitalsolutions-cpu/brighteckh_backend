import { Module } from '@nestjs/common';
import { Br05Controller } from './br05.controller';
import { Br05Service } from './br05.service';
import { InventoryModule } from '../inventory/inventory.module';

@Module({ imports: [InventoryModule], controllers: [Br05Controller], providers: [Br05Service] })
export class Br05Module {}
