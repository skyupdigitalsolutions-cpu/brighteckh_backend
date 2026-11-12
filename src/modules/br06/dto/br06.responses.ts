import { ApiProperty } from '@nestjs/swagger';
import {
  Br06GrnLinesRow, Br06GrnsRow, Br06PoLinesRow, Br06SupplierPurchaseOrdersRow,
} from '../../../common/swagger/rows.generated';

/** GET /purchase-orders/:id */
export class PurchaseOrderDetail extends Br06SupplierPurchaseOrdersRow {
  @ApiProperty({ type: [Br06PoLinesRow], description: 'Ordered by line_no' }) lines!: Br06PoLinesRow[];
}

/** GET /grns/:id */
export class GrnDetail extends Br06GrnsRow {
  @ApiProperty({ type: [Br06GrnLinesRow] }) lines!: Br06GrnLinesRow[];
}
