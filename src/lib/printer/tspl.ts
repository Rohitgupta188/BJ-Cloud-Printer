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

function formatTsplWeight(val?: string | number, fallback = ""): string {
  if (val === undefined || val === null) return fallback;
  const str = String(val).trim();
  if (str === "") return fallback;
  const num = Number(str);
  if (!isNaN(num) && num === 0) return "0.000";
  return str;
}

export function generateTsplPayload(item: TsplItemPayloadInput): string {
  const dNo = item.designNumber ?? "";
  const gWt = formatTsplWeight(item.grossWeight);
  const nWt = formatTsplWeight(item.netWeight);

  const czNum = item.czWeight !== undefined && !isNaN(Number(item.czWeight)) ? Number(item.czWeight) : 0;
  const bsNum = item.bsWeight !== undefined && !isNaN(Number(item.bsWeight)) ? Number(item.bsWeight) : 0;
  const rawStone = item.stoneWeight !== undefined && !isNaN(Number(item.stoneWeight)) ? Number(item.stoneWeight) : 0;
  const effectiveStone = rawStone > 0 ? rawStone : (czNum > 0 || bsNum > 0 ? (czNum + bsNum) : 0);

  const sWt = formatTsplWeight(effectiveStone, "0.000");
  const czWt = formatTsplWeight(item.czWeight, "0.000");
  const bsWt = formatTsplWeight(item.bsWeight, "0.000");
  const rawPurity = item.metalPurity !== undefined && item.metalPurity !== null ? String(item.metalPurity) : "";
  const purity = rawPurity.replace(/[kK\s]/g, "").replace(/T$/i, "");
  const metal = item.metalType ?? "Y";
  // Prefix '1' to every SKU for the physical printer label QR code (e.g. 1TRTP250)
  // while leaving database and website SKUs unchanged.
  const rawSku = (item.skuNumber ?? "").trim();
  const sku = rawSku ? (rawSku.startsWith("1") ? rawSku : `1${rawSku}`) : "";

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

/**
 * Generates an optimized, continuous-stream TSPL batch payload for multiple labels.
 * Emits global configuration headers once at the top, followed by sequential CLS ... PRINT 1,1
 * blocks for each label. This eliminates printer backfeeding and jitter, ensuring a smooth,
 * continuous print run for all labels in the batch.
 */
export function generateTsplBatchPayload(items: TsplItemPayloadInput[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return generateTsplPayload(items[0]);

  const headerLines = [
    "SIZE 90 mm, 70 mm",
    "DIRECTION 0,0",
    "REFERENCE 0,0",
    "OFFSET 0 mm",
    "SET PEEL OFF",
    "SET CUTTER OFF",
    "SET PARTIAL_CUTTER OFF",
    "SET TEAR ON",
    "CODEPAGE 1252"
  ];

  const labelBlocks = items.map((item) => {
    const dNo = item.designNumber ?? "";
    const gWt = formatTsplWeight(item.grossWeight);
    const nWt = formatTsplWeight(item.netWeight);

    const czNum = item.czWeight !== undefined && !isNaN(Number(item.czWeight)) ? Number(item.czWeight) : 0;
    const bsNum = item.bsWeight !== undefined && !isNaN(Number(item.bsWeight)) ? Number(item.bsWeight) : 0;
    const rawStone = item.stoneWeight !== undefined && !isNaN(Number(item.stoneWeight)) ? Number(item.stoneWeight) : 0;
    const effectiveStone = rawStone > 0 ? rawStone : (czNum > 0 || bsNum > 0 ? (czNum + bsNum) : 0);

    const sWt = formatTsplWeight(effectiveStone, "0.000");
    const czWt = formatTsplWeight(item.czWeight, "0.000");
    const bsWt = formatTsplWeight(item.bsWeight, "0.000");
    const rawPurity =
      item.metalPurity !== undefined && item.metalPurity !== null
        ? String(item.metalPurity)
        : "";
    const purity = rawPurity.replace(/[kK\s]/g, "").replace(/T$/i, "");
    const metal = item.metalType ?? "Y";
    const rawSku = (item.skuNumber ?? "").trim();
    const sku = rawSku ? (rawSku.startsWith("1") ? rawSku : `1${rawSku}`) : "";

    return [
      "CLS",
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
      "PRINT 1,1"
    ].join("\r\n");
  });

  return [...headerLines, ...labelBlocks, ""].join("\r\n");
}
