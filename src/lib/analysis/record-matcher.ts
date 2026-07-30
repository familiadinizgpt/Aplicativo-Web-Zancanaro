import * as XLSX from "xlsx";

export const MATCH_KEYS = [
  "data",
  "documento",
  "conta",
  "valor",
  "natureza",
  "empresa",
  "fazenda",
  "safra",
  "cultura",
  "talhao",
  "centroCusto",
  "produto",
  "quantidade",
  "preco",
  "cliente",
  "vencimento",
  "moeda",
  "credor",
] as const;

export type MatchKey = (typeof MATCH_KEYS)[number];

export type StructuredRecord = {
  sheet: string;
  rowNumber: number;
  values: Record<string, unknown>;
};

export type ParsedStructuredFile = {
  records: StructuredRecord[];
  columns: string[];
  warnings: string[];
};

const aliases: Record<MatchKey, string[]> = {
  data: ["data", "dt", "datalancamento", "dtemissao", "emissao", "datadocumento", "datamovimento"],
  documento: ["documento", "doc", "numerodocumento", "nrdocumento", "nrodocumento", "nota", "nf", "titulo"],
  conta: ["conta", "contacontabil", "codconta", "codigoctacontabil"],
  valor: ["valor", "valortotal", "valorliquido", "saldo", "total", "valorbruto"],
  natureza: ["natureza", "tipo", "debito", "credito", "tipomovimento"],
  empresa: ["empresa", "codempresa", "filial", "codigoempresa"],
  fazenda: ["fazenda", "propriedade", "unidade", "unidadeprodutiva"],
  safra: ["safra", "anociclo", "ciclo"],
  cultura: ["cultura", "produtoagricola", "lavoura"],
  talhao: ["talhao", "talhao", "quadra", "lote"],
  centroCusto: ["centrodecusto", "centrocusto", "ccusto", "codcc"],
  produto: ["produto", "item", "mercadoria", "descricao", "descricaoitem"],
  quantidade: ["quantidade", "qtd", "qtde", "volume", "saldoquantidade"],
  preco: ["preco", "precounitario", "valorunitario", "cotacao"],
  cliente: ["cliente", "fornecedor", "parceiro", "razaosocial", "nome"],
  vencimento: ["vencimento", "datavencimento", "dtvencimento", "duedate"],
  moeda: ["moeda", "currency", "moedacontrato"],
  credor: ["credor", "banco", "instituicaofinanceira", "fornecedor"],
};

function asText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

export function normalizeHeader(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function uniqueColumns(header: unknown[]) {
  const used = new Map<string, number>();
  return header.map((cell, index) => {
    const base = asText(cell) || `coluna_${index + 1}`;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

export function parseStructuredFile(buffer: Buffer, fileName: string, limit = 50000): ParsedStructuredFile {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const warnings: string[] = [];
  const records: StructuredRecord[] = [];
  const columns = new Set<string>();

  for (const sheetName of workbook.SheetNames) {
    if (records.length >= limit) break;
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
    const headerIndex = rows.findIndex((row) => row.some((value) => asText(value) !== ""));
    if (headerIndex < 0) continue;

    const header = uniqueColumns(rows[headerIndex]);
    header.forEach((column) => columns.add(column));
    for (let index = headerIndex + 1; index < rows.length && records.length < limit; index += 1) {
      const row = rows[index];
      if (!row.some((value) => asText(value) !== "")) continue;
      records.push({
        sheet: sheetName,
        rowNumber: index + 1,
        values: Object.fromEntries(header.map((column, columnIndex) => [column, row[columnIndex]])),
      });
    }
  }

  if (records.length >= limit) {
    warnings.push(`O cruzamento foi limitado aos primeiros ${limit.toLocaleString("pt-BR")} registros de ${fileName}. Divida o arquivo ou reduza o período para uma conciliação integral.`);
  }
  if (records.length === 0) {
    warnings.push(`${fileName} não contém linhas estruturadas reconhecíveis para cruzamento.`);
  }

  return { records, columns: Array.from(columns), warnings };
}

export function findColumn(columns: string[], key: MatchKey) {
  const normalizedAliases = new Set(aliases[key]);
  const exact = columns.find((column) => normalizedAliases.has(normalizeHeader(column)));
  if (exact) return exact;

  return columns.find((column) => {
    const normalized = normalizeHeader(column);
    return aliases[key].some((alias) => normalized.includes(alias) || alias.includes(normalized));
  }) ?? null;
}

function normalizedNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(6);
  const raw = asText(value)
    .replace(/R\$/gi, "")
    .replace(/\s/g, "")
    .replace(/^\((.+)\)$/, "-$1");
  if (!raw) return "";
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed.toFixed(6) : raw;
}

function normalizedDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
    }
  }
  return asText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^0-9a-z]/gi, "")
    .toLowerCase();
}

function normalizedText(value: unknown) {
  return asText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 .:/_-]/g, "")
    .trim();
}

export function normalizeMatchValue(key: MatchKey, value: unknown) {
  if (["valor", "quantidade", "preco"].includes(key)) return normalizedNumber(value);
  if (["data", "vencimento"].includes(key)) return normalizedDate(value);
  return normalizedText(value);
}

export type MatchResult = {
  matched: number;
  leftUnmatched: number;
  rightUnmatched: number;
  missingKeys: string[];
  mappings: Array<{ key: MatchKey; leftColumn: string | null; rightColumn: string | null }>;
  samples: Array<{
    side: "esquerda" | "direita";
    sheet: string;
    rowNumber: number;
    values: Record<string, string>;
  }>;
};

function valuesForSample(
  record: StructuredRecord,
  mappings: MatchResult["mappings"],
  side: "esquerda" | "direita",
) {
  return Object.fromEntries(
    mappings.map((mapping) => {
      const column = side === "esquerda" ? mapping.leftColumn : mapping.rightColumn;
      return [mapping.key, column ? asText(record.values[column]) : ""];
    }),
  );
}

export function matchRecords(left: ParsedStructuredFile, right: ParsedStructuredFile, keys: MatchKey[]): MatchResult {
  const mappings = keys.map((key) => ({
    key,
    leftColumn: findColumn(left.columns, key),
    rightColumn: findColumn(right.columns, key),
  }));
  const missingKeys = mappings
    .filter((mapping) => !mapping.leftColumn || !mapping.rightColumn)
    .map((mapping) => mapping.key);
  if (missingKeys.length > 0) {
    return { matched: 0, leftUnmatched: left.records.length, rightUnmatched: right.records.length, missingKeys, mappings, samples: [] };
  }

  const signature = (record: StructuredRecord, side: "left" | "right") =>
    mappings
      .map((mapping) => normalizeMatchValue(mapping.key, record.values[side === "left" ? mapping.leftColumn! : mapping.rightColumn!]))
      .join("\u001f");
  const rightIndex = new Map<string, StructuredRecord[]>();
  for (const record of right.records) {
    const key = signature(record, "right");
    const current = rightIndex.get(key) ?? [];
    current.push(record);
    rightIndex.set(key, current);
  }

  let matched = 0;
  const leftUnmatched: StructuredRecord[] = [];
  for (const record of left.records) {
    const candidates = rightIndex.get(signature(record, "left"));
    if (candidates && candidates.length > 0) {
      candidates.shift();
      matched += 1;
    } else {
      leftUnmatched.push(record);
    }
  }
  const rightUnmatched = Array.from(rightIndex.values()).flat();
  const samples = [
    ...leftUnmatched.slice(0, 4).map((record) => ({ side: "esquerda" as const, sheet: record.sheet, rowNumber: record.rowNumber, values: valuesForSample(record, mappings, "esquerda") })),
    ...rightUnmatched.slice(0, 4).map((record) => ({ side: "direita" as const, sheet: record.sheet, rowNumber: record.rowNumber, values: valuesForSample(record, mappings, "direita") })),
  ];

  return { matched, leftUnmatched: leftUnmatched.length, rightUnmatched: rightUnmatched.length, missingKeys, mappings, samples };
}
