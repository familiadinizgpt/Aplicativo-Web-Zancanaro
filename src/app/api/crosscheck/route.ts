import { NextResponse } from "next/server";
import { z } from "zod";

import { MATCH_KEYS, matchRecords, parseStructuredFile, type MatchKey } from "@/lib/analysis/record-matcher";
import { requireSupabaseUser } from "@/lib/supabase/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

const STORAGE_BUCKET = "agro-analysis-files";
const supportedExtensions = new Set(["xlsx", "xls", "csv"]);
const bodySchema = z.object({
  workspaceId: z.string().uuid(),
  leftSourceId: z.string().uuid(),
  rightSourceId: z.string().uuid(),
  keys: z.array(z.enum(MATCH_KEYS)).min(1).max(8),
});

type SourceFile = {
  id: string;
  original_name: string;
  storage_path: string;
  extraction_status: string;
  extraction_method: string | null;
};

function extensionOf(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

export async function POST(request: Request) {
  try {
    const input = bodySchema.parse(await request.json());
    if (input.leftSourceId === input.rightSourceId) {
      return NextResponse.json({ error: "Escolha dois arquivos distintos para cruzar." }, { status: 400 });
    }

    const { supabase, userId } = await requireSupabaseUser();
    const { data, error } = await supabase
      .from("source_files")
      .select("id, original_name, storage_path, extraction_status, extraction_method")
      .eq("workspace_id", input.workspaceId)
      .eq("uploaded_by", userId)
      .in("id", [input.leftSourceId, input.rightSourceId]);
    if (error || !data || data.length !== 2) {
      return NextResponse.json({ error: "Um ou ambos os arquivos não estão disponíveis no espaço autorizado." }, { status: 404 });
    }

    const sources = data as SourceFile[];
    const left = sources.find((source) => source.id === input.leftSourceId)!;
    const right = sources.find((source) => source.id === input.rightSourceId)!;
    const unsupported = [left, right].find((source) => !supportedExtensions.has(extensionOf(source.original_name)));
    if (unsupported) {
      return NextResponse.json(
        { error: `${unsupported.original_name} não é uma planilha/CSV estruturado. O cruzamento automático exige XLSX, XLS ou CSV.` },
        { status: 422 },
      );
    }

    const [leftDownload, rightDownload] = await Promise.all([
      supabase.storage.from(STORAGE_BUCKET).download(left.storage_path),
      supabase.storage.from(STORAGE_BUCKET).download(right.storage_path),
    ]);
    if (leftDownload.error || rightDownload.error || !leftDownload.data || !rightDownload.data) {
      return NextResponse.json({ error: "Não foi possível acessar os dois arquivos privados para cruzamento." }, { status: 400 });
    }

    const [leftParsed, rightParsed] = await Promise.all([
      Promise.resolve(parseStructuredFile(Buffer.from(await leftDownload.data.arrayBuffer()), left.original_name)),
      Promise.resolve(parseStructuredFile(Buffer.from(await rightDownload.data.arrayBuffer()), right.original_name)),
    ]);
    const result = matchRecords(leftParsed, rightParsed, input.keys as MatchKey[]);
    const warnings = [
      ...leftParsed.warnings,
      ...rightParsed.warnings,
      left.extraction_status === "needs_review" || right.extraction_status === "needs_review"
        ? "Pelo menos um arquivo tem alerta de extração. Revise a origem antes de considerar o resultado conciliado."
        : null,
    ].filter((item): item is string => Boolean(item));

    return NextResponse.json({
      left: { id: left.id, fileName: left.original_name, records: leftParsed.records.length },
      right: { id: right.id, fileName: right.original_name, records: rightParsed.records.length },
      keys: input.keys,
      ...result,
      warnings,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Acesse seu espaço seguro antes de executar cruzamentos." }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "Não foi possível executar o cruzamento.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
