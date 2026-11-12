import { Module } from '@nestjs/common';
import { Br04Controller } from './br04.controller';
import { Br04Service } from './br04.service';
import { InventoryModule } from '../inventory/inventory.module';

@Module({ imports: [InventoryModule], controllers: [Br04Controller], providers: [Br04Service] })
export class Br04Module {}
