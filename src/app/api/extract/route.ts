import * as mammoth from "mammoth";
import { NextResponse } from "next/server";
import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";
import { z } from "zod";

import { requireSupabaseUser } from "@/lib/supabase/auth";
import type { DataCategoryId, ExtractedSource } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const STORAGE_BUCKET = "agro-analysis-files";
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const sourceRequestSchema = z.object({
  sourceFileId: z.string().uuid(),
});

const supportedExtensions = new Set([
  "xlsx",
  "xls",
  "csv",
  "pdf",
  "docx",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "txt",
]);

type RawSource = {
  id: string;
  workspace_id: string;
  category: string;
  requirement_id: string | null;
  original_name: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  extraction_status: string;
  extraction_method: string | null;
  record_count: number;
  columns_json: unknown;
  preview_json: unknown;
  warnings_json: unknown;
  created_at: string;
};

type ExtractedContent = {
  method: ExtractedSource["extractionMethod"];
  columns: string[];
  recordCount: number;
  previewRows: ExtractedSource["previewRows"];
  evidence: ExtractedSource["evidence"];
  warnings: string[];
};

function extensionOf(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function asText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function snippetsFromText(text: string, prefix = "Trecho"): ExtractedSource["evidence"] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const chunkSize = 700;
  return Array.from({ length: Math.min(6, Math.ceil(normalized.length / chunkSize)) }, (_, index) => ({
    reference: `${prefix} ${index + 1}`,
    text: normalized.slice(index * chunkSize, (index + 1) * chunkSize),
  }));
}

function previewFromRows(rows: unknown[][]) {
  const headerIndex = rows.findIndex((row) => row.some((cell) => asText(cell) !== ""));
  if (headerIndex < 0) {
    return { columns: [], recordCount: 0, previewRows: [] as ExtractedSource["previewRows"] };
  }

  const columns = rows[headerIndex].map((cell, index) => asText(cell) || `coluna_${index + 1}`);
  const dataRows = rows.slice(headerIndex + 1).filter((row) => row.some((cell) => asText(cell) !== ""));
  const previewRows = dataRows.slice(0, 12).map((row) =>
    Object.fromEntries(columns.map((column, index) => [column, asText(row[index]) || null])),
  );
  return { columns, recordCount: dataRows.length, previewRows };
}

async function extractWorkbook(buffer: Buffer): Promise<ExtractedContent> {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const warnings: string[] = [];
  const allRows: unknown[][] = [];
  const evidence: ExtractedSource["evidence"] = [];

  for (const sheetName of workbook.SheetNames.slice(0, 8)) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
    const parsed = previewFromRows(rows);
    if (parsed.columns.length > 0) {
      allRows.push(parsed.columns, ...rows.slice(1, Math.min(rows.length, 15)));
      evidence.push({
        reference: `Aba: ${sheetName}`,
        text: `Colunas identificadas: ${parsed.columns.join(" | ")}. Registros não vazios: ${parsed.recordCount}.`,
      });
    }
  }

  if (workbook.SheetNames.length > 8) {
    warnings.push("Somente as primeiras 8 abas foram pré-visualizadas; confirme as demais antes de concluir a análise.");
  }

  const preview = previewFromRows(allRows);
  return {
    method: "structured",
    columns: preview.columns,
    recordCount: evidence.reduce((total, fragment) => {
      const match = fragment.text.match(/Registros não vazios: (\d+)/);
      return total + Number(match?.[1] ?? 0);
    }, 0),
    previewRows: preview.previewRows,
    evidence,
    warnings,
  };
}

async function extractCsv(buffer: Buffer): Promise<ExtractedContent> {
  const text = buffer.toString("utf8");
  const workbook = XLSX.read(buffer, { type: "buffer", raw: true });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = firstSheet
    ? XLSX.utils.sheet_to_json<unknown[]>(firstSheet, { header: 1, defval: "" })
    : [];
  const preview = previewFromRows(rows);
  return {
    method: "structured",
    columns: preview.columns,
    recordCount: preview.recordCount,
    previewRows: preview.previewRows,
    evidence: snippetsFromText(text, "CSV"),
    warnings: [],
  };
}

async function extractPdf(buffer: Buffer): Promise<ExtractedContent> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText({ first: 30 });
    const text = result.text.trim();
    if (!text) {
      const pageLimit = Math.min(result.total, 8);
      const screenshots = await parser.getScreenshot({ first: pageLimit, desiredWidth: 1800, imageBuffer: true, imageDataUrl: false });
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("por");
      try {
        const evidence: ExtractedSource["evidence"] = [];
        for (const page of screenshots.pages) {
          const recognized = await worker.recognize(Buffer.from(page.data));
          const pageText = recognized.data.text.replace(/\s+/g, " ").trim();
          if (pageText) {
            evidence.push({ reference: `Página ${page.pageNumber} · OCR`, text: pageText.slice(0, 1400) });
          }
        }
        return {
          method: "ocr",
          columns: [],
          recordCount: 0,
          previewRows: [],
          evidence,
          warnings: [
            `OCR aplicado em ${pageLimit} de ${result.total} página(s). Revise valores, datas, sinais e nomes antes dos cálculos.`,
            ...(result.total > pageLimit ? [`O PDF possui ${result.total} páginas; divida-o em arquivos de até ${pageLimit} páginas para OCR integral.`] : []),
            ...(evidence.length === 0 ? ["O OCR não reconheceu texto suficiente; envie uma digitalização mais nítida."] : []),
          ],
        };
      } finally {
        await worker.terminate();
      }
    }
    return {
      method: "text",
      columns: [],
      recordCount: 0,
      previewRows: [],
      evidence: result.pages.slice(0, 6).map((page) => ({
        reference: `Página ${page.num}`,
        text: page.text.replace(/\s+/g, " ").trim().slice(0, 700),
      })),
      warnings: result.total > 30
        ? ["Foram extraídas as primeiras 30 páginas para prévia. Divida o PDF para processar o conteúdo integral."]
        : [],
    };
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(buffer: Buffer): Promise<ExtractedContent> {
  const result = await mammoth.extractRawText({ buffer });
  return {
    method: "text",
    columns: [],
    recordCount: 0,
    previewRows: [],
    evidence: snippetsFromText(result.value, "Documento"),
    warnings: result.messages.map((message) => message.message),
  };
}

async function extractImage(buffer: Buffer): Promise<ExtractedContent> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("por");
  try {
    const result = await worker.recognize(buffer);
    const text = result.data.text.trim();
    return {
      method: "ocr",
      columns: [],
      recordCount: 0,
      previewRows: [],
      evidence: snippetsFromText(text, "OCR"),
      warnings: text
        ? ["OCR concluído. Revise nomes, valores, datas, vírgulas e sinais antes de usar qualquer cálculo."]
        : ["Não foi possível reconhecer texto suficiente. Envie uma imagem mais nítida ou registre os dados manualmente."],
    };
  } finally {
    await worker.terminate();
  }
}

async function extractFile(buffer: Buffer, fileName: string): Promise<ExtractedContent> {
  const extension = extensionOf(fileName);
  if (!supportedExtensions.has(extension)) {
    throw new Error("Formato ainda não suportado para extração.");
  }
  if (extension === "xlsx" || extension === "xls") return extractWorkbook(buffer);
  if (extension === "csv") return extractCsv(buffer);
  if (extension === "pdf") return extractPdf(buffer);
  if (extension === "docx") return extractDocx(buffer);
  if (["png", "jpg", "jpeg", "webp"].includes(extension)) return extractImage(buffer);
  return {
    method: "text",
    columns: [],
    recordCount: 0,
    previewRows: [],
    evidence: snippetsFromText(buffer.toString("utf8"), "Texto"),
    warnings: [],
  };
}

function toSource(
  source: RawSource,
  extracted: ExtractedContent,
  status: ExtractedSource["status"],
): ExtractedSource {
  return {
    id: source.id,
    category: source.category as DataCategoryId,
    requirementId: source.requirement_id,
    fileName: source.original_name,
    storagePath: source.storage_path,
    mimeType: source.mime_type,
    size: source.byte_size,
    status,
    extractionMethod: extracted.method,
    recordCount: extracted.recordCount,
    columns: extracted.columns,
    previewRows: extracted.previewRows,
    evidence: extracted.evidence,
    warnings: extracted.warnings,
    importedAt: source.created_at,
  };
}

export async function POST(request: Request) {
  let sourceId: string | null = null;
  let userId: string | null = null;
  let supabase: Awaited<ReturnType<typeof requireSupabaseUser>>["supabase"] | null = null;

  try {
    const body = sourceRequestSchema.parse(await request.json());
    sourceId = body.sourceFileId;
    const authenticated = await requireSupabaseUser();
    supabase = authenticated.supabase;
    userId = authenticated.userId;

    const { data, error } = await supabase
      .from("source_files")
      .select("id, workspace_id, category, requirement_id, original_name, storage_path, mime_type, byte_size, extraction_status, extraction_method, record_count, columns_json, preview_json, warnings_json, created_at")
      .eq("id", sourceId)
      .eq("uploaded_by", userId)
      .single();
    if (error || !data) {
      return NextResponse.json({ error: "Arquivo não encontrado no espaço autorizado." }, { status: 404 });
    }
    const source = data as RawSource;

    if (source.byte_size > MAX_FILE_SIZE) {
      await supabase.from("source_files").update({ extraction_status: "failed" }).eq("id", source.id);
      return NextResponse.json({ error: "O arquivo excede o limite de 25 MB deste processamento." }, { status: 400 });
    }

    await supabase.from("source_files").update({ extraction_status: "processing" }).eq("id", source.id);
    const { data: blob, error: downloadError } = await supabase.storage.from(STORAGE_BUCKET).download(source.storage_path);
    if (downloadError || !blob) {
      throw new Error("Não foi possível recuperar o arquivo privado para extração.");
    }

    const extracted = await extractFile(Buffer.from(await blob.arrayBuffer()), source.original_name);
    const status: ExtractedSource["status"] =
      extracted.warnings.length > 0 || extracted.evidence.length === 0 ? "needs-review" : "ready";
    const databaseStatus = status === "needs-review" ? "needs_review" : "ready";

    const { error: updateError } = await supabase
      .from("source_files")
      .update({
        extraction_status: databaseStatus,
        extraction_method: extracted.method.replace("-", "_"),
        record_count: extracted.recordCount,
        columns_json: extracted.columns,
        preview_json: extracted.previewRows,
        warnings_json: extracted.warnings,
        updated_at: new Date().toISOString(),
      })
      .eq("id", source.id);
    if (updateError) throw new Error("Não foi possível registrar a extração do arquivo.");

    const { error: deleteEvidenceError } = await supabase.from("evidence_fragments").delete().eq("source_file_id", source.id);
    if (deleteEvidenceError) throw new Error("Não foi possível atualizar as evidências extraídas.");
    if (extracted.evidence.length > 0) {
      const { error: insertEvidenceError } = await supabase.from("evidence_fragments").insert(
        extracted.evidence.map((item, ordinal) => ({
          source_file_id: source.id,
          reference: item.reference,
          content: item.text,
          ordinal,
        })),
      );
      if (insertEvidenceError) throw new Error("Não foi possível salvar as evidências extraídas.");
    }

    return NextResponse.json({ source: toSource(source, extracted, status) });
  } catch (error) {
    if (supabase && sourceId && userId) {
      await supabase
        .from("source_files")
        .update({ extraction_status: "failed", updated_at: new Date().toISOString() })
        .eq("id", sourceId)
        .eq("uploaded_by", userId);
    }

    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Acesse seu espaço seguro antes de processar os documentos." }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "Não foi possível extrair o arquivo.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
