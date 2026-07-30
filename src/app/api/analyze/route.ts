import { APICallError, generateText, Output } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSupabaseUser } from "@/lib/supabase/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  workspaceId: z.string().uuid(),
  sourceIds: z.array(z.string().uuid()).min(1).max(40),
  baseline: z.object({
    sourceId: z.string().uuid(),
    reference: z.string().max(240),
  }),
  financialBase: z.record(z.string(), z.number().nullable()),
  scenarioAssumptions: z.record(
    z.string(),
    z.object({
      values: z.record(z.string(), z.number().nullable()),
      sourceId: z.string().uuid(),
      reference: z.string().max(200),
    }),
  ),
  scenarioResults: z.record(
    z.string(),
    z.object({
      isCalculable: z.boolean(),
      revenue: z.number().nullable(),
      cashAtEnd: z.number().nullable(),
      operatingMargin: z.number().nullable(),
      estimatedResult: z.number().nullable(),
    }),
  ),
});

const outputSchema = z.object({
  executiveSummary: z.string().max(1600),
  findings: z.array(
    z.object({
      title: z.string().max(180),
      classification: z.enum(["fato", "inferência", "recomendação", "lacuna"]),
      explanation: z.string().max(700),
      evidence: z.array(z.string().max(220)).max(5),
      confidence: z.number().int().min(0).max(100),
    }),
  ).max(12),
  dataGaps: z.array(z.string().max(400)).max(12),
  consistencyChecks: z.array(z.string().max(400)).max(12),
  decisionQuestions: z.array(z.string().max(400)).max(8),
});

type DbSource = {
  id: string;
  original_name: string;
  category: string;
  extraction_status: string;
  extraction_method: string | null;
  record_count: number;
  columns_json: unknown;
  warnings_json: unknown;
  evidence_fragments: Array<{ reference: string; content: string; ordinal: number }> | null;
};

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function POST(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
    const { supabase, userId } = await requireSupabaseUser();
    if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
      return NextResponse.json(
        { error: "A IA está indisponível neste ambiente. Habilite o AI Gateway da Vercel ou configure uma chave somente no servidor." },
        { status: 503 },
      );
    }
    const uniqueSourceIds = Array.from(new Set(payload.sourceIds));
    const { data, error } = await supabase
      .from("source_files")
      .select("id, original_name, category, extraction_status, extraction_method, record_count, columns_json, warnings_json, evidence_fragments(reference, content, ordinal)")
      .eq("workspace_id", payload.workspaceId)
      .eq("uploaded_by", userId)
      .in("id", uniqueSourceIds);
    if (error || !data || data.length !== uniqueSourceIds.length) {
      return NextResponse.json({ error: "Há fontes ausentes ou fora do espaço autorizado." }, { status: 404 });
    }

    const sources = (data as DbSource[]).map((source) => ({
      id: source.id,
      fileName: source.original_name,
      category: source.category,
      status: source.extraction_status === "ready" ? "ready" : "needs-review",
      extractionMethod: (source.extraction_method ?? "manual_review").replace("_", "-"),
      recordCount: source.record_count,
      columns: stringArray(source.columns_json).slice(0, 40),
      evidence: (source.evidence_fragments ?? [])
        .sort((a, b) => a.ordinal - b.ordinal)
        .slice(0, 6)
        .map((item) => ({ reference: item.reference, text: item.content.slice(0, 900) })),
      warnings: stringArray(source.warnings_json).slice(0, 10),
    }));
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const baselineSource = sourceById.get(payload.baseline.sourceId);
    const assumptionSources = Object.values(payload.scenarioAssumptions).map((assumption) => sourceById.get(assumption.sourceId));
    if (!baselineSource || assumptionSources.some((source) => !source)) {
      return NextResponse.json(
        { error: "A base e cada premissa precisam apontar para fontes do espaço de análise autorizado." },
        { status: 400 },
      );
    }
    const scenarioAssumptions = Object.fromEntries(
      Object.entries(payload.scenarioAssumptions).map(([driver, assumption]) => [
        driver,
        {
          values: assumption.values,
          sourceName: sourceById.get(assumption.sourceId)?.fileName ?? "Fonte não identificada",
          reference: assumption.reference,
        },
      ]),
    );

    const evidencePack = JSON.stringify(
      {
        sources,
        baseline: {
          sourceName: baselineSource.fileName,
          reference: payload.baseline.reference,
        },
        financialBase: payload.financialBase,
        scenarioAssumptions,
        scenarioResults: payload.scenarioResults,
      },
      null,
      2,
    );

    const result = await generateText({
      model: "openai/gpt-5.4",
      output: Output.object({ schema: outputSchema }),
      maxOutputTokens: 3000,
      providerOptions: {
        gateway: {
          user: userId,
          tags: ["feature:evidence-analysis", "domain:agriculture"],
        },
      },
      instructions: `Você é um analista de controladoria e agronegócio sob política de evidência estrita.

Regras imutáveis:
- Use exclusivamente o pacote de evidências recebido.
- Nunca invente números, percentuais, causas, fontes, benchmarks ou fatos.
- Todo dado que venha de campo preenchido pelo usuário deve ser tratado como premissa registrada, nunca como fato documental, salvo se tiver fonte e referência explícitas.
- Qualquer leitura que combine mais de uma fonte deve ser classificada como "inferência" e explicar a limitação.
- Quando uma informação não estiver provada, registre como "lacuna" ou em dataGaps.
- Não altere cálculos de cenário recebidos. Apenas explique os resultados e suas limitações.
- Cite cada achado com arquivo e referência de trecho, aba ou página existente no pacote.
- Não faça recomendações de compra, venda, endividamento ou investimento sem evidência suficiente; nesse caso formule a pergunta de decisão que falta responder.
- Escreva em português do Brasil, claro para diretoria.`,
      prompt: `Analise o pacote abaixo e retorne somente a estrutura solicitada.\n\n${evidencePack}`,
    });

    const { error: reportError } = await supabase.from("analysis_reports").insert({
      workspace_id: payload.workspaceId,
      created_by: userId,
      analysis_json: result.output,
    });
    if (reportError) {
      console.warn("A análise foi concluída, mas o histórico não pôde ser salvo.");
    }

    return NextResponse.json({ analysis: result.output });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Acesse seu espaço seguro antes de solicitar a análise por IA." }, { status: 401 });
    }
    if (APICallError.isInstance(error)) {
      if (error.statusCode === 402) {
        return NextResponse.json({ error: "O limite de uso da IA foi atingido. Revise o orçamento do AI Gateway." }, { status: 402 });
      }
      if (error.statusCode === 429) {
        return NextResponse.json({ error: "A IA recebeu muitas solicitações. Aguarde um instante e tente novamente." }, { status: 429 });
      }
    }
    console.error("Erro na análise por IA", error);
    return NextResponse.json(
      { error: "A análise não foi concluída. Verifique as fontes e tente novamente; nenhum dado foi criado como substituto." },
      { status: 400 },
    );
  }
}
