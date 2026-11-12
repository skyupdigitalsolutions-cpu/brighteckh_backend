import { Module } from '@nestjs/common';
import { Br07Controller } from './br07.controller';
import { Br07Service } from './br07.service';
import { InventoryModule } from '../inventory/inventory.module';

@Module({ imports: [InventoryModule], controllers: [Br07Controller], providers: [Br07Service] })
export class Br07Module {}
