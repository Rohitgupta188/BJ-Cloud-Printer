export interface TsplItemPayloadInput {
  skuNumber: string;
  designNumber?: string;
  grossWeight?: string | number;
  netWeight?: string | number;
  stoneWeight?: string | number;
  metalPurity?: string | number;
  metalType?: string;
  czWeight?: string | number;
  bsWeight?: string | number;
}

export function generateTsplPayload(item: TsplItemPayloadInput): string {
  const dNo = item.designNumber ?? "";
  const gWt = item.grossWeight !== undefined && item.grossWeight !== null ? String(item.grossWeight) : "";
  const nWt = item.netWeight !== undefined && item.netWeight !== null ? String(item.netWeight) : "";
  const sWt = item.stoneWeight !== undefined && item.stoneWeight !== null ? String(item.stoneWeight) : "";
  const czWt = item.czWeight !== undefined && item.czWeight !== null ? String(item.czWeight) : "";
  const bsWt = item.bsWeight !== undefined && item.bsWeight !== null ? String(item.bsWeight) : "";
  const purity = item.metalPurity !== undefined && item.metalPurity !== null ? String(item.metalPurity) : "";
  const metal = item.metalType ?? "Y";
  const sku = item.skuNumber ?? "";

  const lines = [
    "SIZE 90 mm, 70 mm",
    "DIRECTION 0,0",
    "REFERENCE 0,0",
    "OFFSET 0 mm",
    "SET PEEL OFF",
    "SET CUTTER OFF",
    "SET PARTIAL_CUTTER OFF",
    "SET TEAR ON",
    "CLS",
    "CODEPAGE 1252",
    `TEXT 380,105,"ROMAN.TTF",180,1,6,"D.No: ${dNo}"`,
    `TEXT 380,85,"ROMAN.TTF",180,1,6,"G.Wt: ${gWt}"`,
    `TEXT 300,85,"ROMAN.TTF",180,1,6,"CZ: ${czWt}"`,
    `TEXT 380,65,"ROMAN.TTF",180,1,6,"S Wt: ${sWt}"`,
    `TEXT 380,45,"ROMAN.TTF",180,1,6,"N Wt: ${nWt}"`,
    `TEXT 300,45,"ROMAN.TTF",180,1,6,"KT: ${purity}"`,
    `TEXT 300,65,"ROMAN.TTF",180,1,6,"BS: ${bsWt}"`,
    `QRCODE 150,100,H,3,A,180,M2,S7,"${sku}"`,
    `TEXT 230,85,"ROMAN.TTF",180,1,6,"G.Wt: ${gWt}"`,
    `TEXT 230,65,"ROMAN.TTF",180,1,6,"N Wt: ${nWt}"`,
    `TEXT 565,42,"0",180,9,9,"${dNo}/${gWt}"`,
    `TEXT 230,45,"ROMAN.TTF",180,1,6,"KT: ${purity}"`,
    `TEXT 180,45,"ROMAN.TTF",180,1,6,"${metal}"`,
    "PRINT 1,1",
    ""
  ];

  return lines.join("\r\n");
}
