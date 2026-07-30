import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSupabaseUser } from "@/lib/supabase/auth";
import { DATA_CATEGORIES } from "@/lib/types";

export const runtime = "nodejs";

const scenarioSchema = z.object({
  label: z.string().max(40),
  isCalculable: z.boolean(),
  revenue: z.number().nullable(),
  cashAtEnd: z.number().nullable(),
  operatingMargin: z.number().nullable(),
  estimatedResult: z.number().nullable(),
  notes: z.array(z.string().max(400)).max(8),
});

const requestSchema = z.object({
  generatedAt: z.string().max(80),
  workspaceId: z.string().uuid(),
  sourceIds: z.array(z.string().uuid()).min(1).max(50),
  baseSourceId: z.string().uuid(),
  baseReference: z.string().max(240),
  assumptions: z.array(
    z.object({
      label: z.string().max(100),
      sourceId: z.string().uuid(),
      reference: z.string().max(240),
      pessimistic: z.number(),
      normal: z.number(),
      optimistic: z.number(),
    }),
  ).min(1).max(10),
  scenarios: z.object({
    pessimistic: scenarioSchema,
    normal: scenarioSchema,
    optimistic: scenarioSchema,
  }),
  analysis: z.object({
    executiveSummary: z.string().max(1800),
    findings: z.array(
      z.object({
        title: z.string().max(180),
        classification: z.string().max(30),
        explanation: z.string().max(800),
        evidence: z.array(z.string().max(220)).max(5),
        confidence: z.number().min(0).max(100),
      }),
    ).max(12),
    dataGaps: z.array(z.string().max(400)).max(15),
  }).nullable(),
});

const FONT = "Arial";
const COLORS = {
  green: "1E5B45",
  ink: "18211D",
  muted: "5B6761",
  line: "D8E2DC",
  pale: "EFF6F1",
  amber: "B97810",
};

function brl(value: number | null) {
  if (value === null) return "Não calculado";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(value);
}

function percent(value: number | null) {
  if (value === null) return "Não calculado";
  return new Intl.NumberFormat("pt-BR", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function cell(text: string, options?: { header?: boolean; width?: number }) {
  return new TableCell({
    width: options?.width ? { size: options.width, type: WidthType.DXA } : undefined,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    verticalAlign: "center",
    shading: options?.header ? { fill: COLORS.green, type: ShadingType.CLEAR } : undefined,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
    },
    children: [
      new Paragraph({
        spacing: { before: 0, after: 0 },
        children: [
          new TextRun({
            text,
            bold: Boolean(options?.header),
            color: options?.header ? "FFFFFF" : COLORS.ink,
            font: FONT,
            size: 18,
          }),
        ],
      }),
    ],
  });
}

function table(rows: string[][], widths: number[]) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    alignment: AlignmentType.CENTER,
    rows: rows.map((row, index) =>
      new TableRow({
        tableHeader: index === 0,
        children: row.map((value, column) => cell(value, { header: index === 0, width: widths[column] })),
      }),
    ),
  });
}

function heading(text: string, level: typeof HeadingLevel.HEADING_1 | typeof HeadingLevel.HEADING_2) {
  return new Paragraph({
    heading: level,
    spacing: { before: level === HeadingLevel.HEADING_1 ? 260 : 180, after: 100 },
    children: [new TextRun({ text, font: FONT, color: COLORS.green, bold: true })],
  });
}

function sourceMethodLabel(method: string | null) {
  const labels: Record<string, string> = {
    structured: "Estruturada",
    text: "Texto extraído",
    ocr: "OCR",
    manual_review: "Revisão manual",
  };
  return labels[method ?? ""] ?? "Não identificado";
}

function sourceStatusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: "Na fila",
    processing: "Processando",
    ready: "Pronto",
    needs_review: "Revisão necessária",
    failed: "Falhou",
  };
  return labels[status] ?? status;
}

function sourceCategoryLabel(category: string) {
  return DATA_CATEGORIES.find((item) => item.id === category)?.label ?? category;
}

export async function POST(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
    const { supabase, userId } = await requireSupabaseUser();
    const { data: workspace, error: workspaceError } = await supabase
      .from("analysis_workspaces")
      .select("id")
      .eq("id", payload.workspaceId)
      .eq("owner_id", userId)
      .maybeSingle();

    if (workspaceError) throw workspaceError;
    if (!workspace) {
      return NextResponse.json({ error: "Espaço de análise não encontrado ou não autorizado." }, { status: 404 });
    }

    const uniqueSourceIds = Array.from(new Set(payload.sourceIds));
    const { data: verifiedSources, error: sourceError } = await supabase
      .from("source_files")
      .select("id, original_name, category, extraction_method, extraction_status")
      .eq("workspace_id", payload.workspaceId)
      .eq("uploaded_by", userId)
      .in("id", uniqueSourceIds);

    if (sourceError) throw sourceError;
    if (!verifiedSources || verifiedSources.length !== uniqueSourceIds.length) {
      return NextResponse.json(
        { error: "Uma ou mais fontes não pertencem ao seu espaço de análise." },
        { status: 400 },
      );
    }

    const sourcesById = new Map(verifiedSources.map((source) => [source.id, source]));
    const baseSource = sourcesById.get(payload.baseSourceId);
    if (!baseSource) {
      return NextResponse.json({ error: "A fonte-base não foi localizada no espaço de análise." }, { status: 400 });
    }
    if (payload.assumptions.some((assumption) => !sourcesById.has(assumption.sourceId))) {
      return NextResponse.json(
        { error: "Cada premissa precisa apontar para uma fonte do espaço de análise." },
        { status: 400 },
      );
    }

    const scenarios = [payload.scenarios.pessimistic, payload.scenarios.normal, payload.scenarios.optimistic];
    if (scenarios.some((scenario) => !scenario.isCalculable)) {
      return NextResponse.json(
        { error: "A exportação exige valores-base e premissas documentadas para os três cenários." },
        { status: 400 },
      );
    }

    const children = [
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: "INTELIGÊNCIA AGRÍCOLA", font: FONT, color: COLORS.green, bold: true, size: 20 })],
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [
          new TextRun({
            text: "Análise Comparativa de Cenários",
            font: FONT,
            color: COLORS.ink,
            bold: true,
            size: 36,
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 220 },
        children: [
          new TextRun({
            text: `Cenários pessimista, normal e otimista • Gerado em ${payload.generatedAt}`,
            font: FONT,
            color: COLORS.muted,
            size: 19,
          }),
        ],
      }),
      new Paragraph({
        shading: { fill: COLORS.pale, type: ShadingType.CLEAR },
        spacing: { before: 120, after: 120, line: 280 },
        indent: { left: 160, right: 160 },
        children: [
          new TextRun({
            text: "Nota metodológica: este relatório não prevê o futuro nem cria dados. Ele mostra o efeito matemático das premissas informadas, vinculadas às fontes indicadas. Toda conclusão exige revisão da direção, controladoria e responsáveis operacionais.",
            font: FONT,
            color: COLORS.ink,
            size: 19,
          }),
        ],
      }),
      heading("1. Base documental", HeadingLevel.HEADING_1),
      new Paragraph({
        spacing: { after: 80 },
        children: [
          new TextRun({ text: "Valores-base: ", font: FONT, bold: true, color: COLORS.ink, size: 19 }),
          new TextRun({ text: `${baseSource.original_name} — ${payload.baseReference}`, font: FONT, color: COLORS.ink, size: 19 }),
        ],
      }),
      table(
        [["Arquivo", "Área", "Método", "Status"], ...verifiedSources.map((source) => [
          source.original_name,
          sourceCategoryLabel(source.category),
          sourceMethodLabel(source.extraction_method),
          sourceStatusLabel(source.extraction_status),
        ])],
        [3400, 2200, 1800, 1960],
      ),
      heading("2. Premissas e osciladores", HeadingLevel.HEADING_1),
      new Paragraph({
        spacing: { after: 90 },
        children: [
          new TextRun({
            text: "Variações em relação à base informada. Cada premissa deve ser lida em conjunto com a referência documental indicada.",
            font: FONT,
            color: COLORS.muted,
            size: 19,
          }),
        ],
      }),
      table(
        [
          ["Oscilador", "Pessimista", "Normal", "Otimista", "Fonte / referência"],
          ...payload.assumptions.map((item) => [
            item.label,
            `${item.pessimistic.toFixed(1)}%`,
            `${item.normal.toFixed(1)}%`,
            `${item.optimistic.toFixed(1)}%`,
            `${sourcesById.get(item.sourceId)?.original_name ?? "Fonte não identificada"} — ${item.reference}`,
          ]),
        ],
        [1900, 1260, 1260, 1260, 3680],
      ),
      heading("3. Comparativo de cenários", HeadingLevel.HEADING_1),
      table(
        [
          ["Métrica", "Pessimista", "Normal", "Otimista"],
          ["Receita estimada", ...scenarios.map((scenario) => brl(scenario.revenue))],
          ["Resultado gerencial estimado", ...scenarios.map((scenario) => brl(scenario.estimatedResult))],
          ["Margem operacional", ...scenarios.map((scenario) => percent(scenario.operatingMargin))],
          ["Caixa ao final do período", ...scenarios.map((scenario) => brl(scenario.cashAtEnd))],
        ],
        [3100, 2086, 2086, 2088],
      ),
      heading("4. Limites de interpretação", HeadingLevel.HEADING_1),
      ...payload.scenarios.normal.notes.map(
        (note) =>
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 40 },
            children: [new TextRun({ text: note, font: FONT, color: COLORS.ink, size: 19 })],
          }),
      ),
    ];

    if (payload.analysis) {
      children.push(
        heading("5. Leitura assistida por IA", HeadingLevel.HEADING_1),
        new Paragraph({
          spacing: { after: 100, line: 280 },
          children: [new TextRun({ text: payload.analysis.executiveSummary, font: FONT, color: COLORS.ink, size: 19 })],
        }),
      );
      for (const finding of payload.analysis.findings) {
        children.push(
          new Paragraph({
            spacing: { before: 80, after: 20 },
            children: [
              new TextRun({ text: `${finding.classification.toUpperCase()} — ${finding.title}`, font: FONT, color: COLORS.green, bold: true, size: 19 }),
            ],
          }),
          new Paragraph({
            spacing: { after: 20, line: 280 },
            children: [new TextRun({ text: finding.explanation, font: FONT, color: COLORS.ink, size: 19 })],
          }),
          new Paragraph({
            spacing: { after: 60 },
            children: [
              new TextRun({
                text: `Evidência: ${finding.evidence.join("; ")} • Confiança: ${finding.confidence}%`,
                font: FONT,
                color: COLORS.muted,
                size: 17,
              }),
            ],
          }),
        );
      }
      if (payload.analysis.dataGaps.length > 0) {
        children.push(heading("6. Lacunas a validar", HeadingLevel.HEADING_1));
        for (const gap of payload.analysis.dataGaps) {
          children.push(
            new Paragraph({
              bullet: { level: 0 },
              spacing: { after: 40 },
              children: [new TextRun({ text: gap, font: FONT, color: COLORS.ink, size: 19 })],
            }),
          );
        }
      }
    }

    const document = new Document({
      creator: "Inteligência Agrícola",
      title: "Análise Comparativa de Cenários",
      description: "Relatório gerado a partir de premissas documentadas.",
      sections: [
        {
          properties: { page: { margin: { top: 1000, right: 1080, bottom: 1000, left: 1080 } } },
          children,
        },
      ],
    });

    const buffer = await Packer.toBuffer(document);
    const bytes = Uint8Array.from(buffer);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": 'attachment; filename="analise-comparativa-cenarios.docx"',
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Acesse o espaço seguro antes de exportar o relatório." }, { status: 401 });
    }
    console.error("Erro ao exportar relatório", error);
    return NextResponse.json(
      { error: "Não foi possível gerar o documento. Revise se todas as premissas e fontes foram preenchidas." },
      { status: 400 },
    );
  }
}
