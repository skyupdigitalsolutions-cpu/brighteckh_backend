import { Module } from '@nestjs/common';
import { Br11Controller } from './br11.controller';
import { Br11Service } from './br11.service';
import { InventoryModule } from '../inventory/inventory.module';

@Module({ imports: [InventoryModule], controllers: [Br11Controller], providers: [Br11Service] })
export class Br11Module {}
