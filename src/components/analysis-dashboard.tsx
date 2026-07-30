"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type DragEvent } from "react";

import {
  calculateAllScenarios,
  createEmptySimulationInput,
  DRIVER_DEFINITIONS,
  getMissingSimulationRequirements,
} from "@/lib/analysis/scenario-engine";
import { type MatchKey } from "@/lib/analysis/record-matcher";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  DATA_CATEGORIES,
  SCENARIO_KEYS,
  SCENARIO_LABELS,
  type AiAnalysisResult,
  type DataCategoryId,
  type DriverId,
  type ExtractedSource,
  type FinancialBase,
  type ScenarioKey,
  type SimulationInput,
} from "@/lib/types";

type View = "overview" | "ingestion" | "crosscheck" | "scenarios" | "report";
type AsyncState = "idle" | "working" | "error" | "done";
type SecurityState = "checking" | "ready" | "signed-out" | "unconfigured" | "error";
type UploadTaskState = "uploading" | "extracting" | "ready" | "error";

type UploadTask = {
  id: string;
  fileName: string;
  category: DataCategoryId;
  state: UploadTaskState;
  error?: string;
};

type CrossCheckDefinition = {
  id: string;
  label: string;
  leftCategory: DataCategoryId;
  rightCategory: DataCategoryId;
  keys: MatchKey[];
};

type CrossCheckRun = {
  left: { id: string; fileName: string; records: number };
  right: { id: string; fileName: string; records: number };
  keys: MatchKey[];
  matched: number;
  leftUnmatched: number;
  rightUnmatched: number;
  missingKeys: string[];
  mappings: Array<{ key: MatchKey; leftColumn: string | null; rightColumn: string | null }>;
  samples: Array<{ side: "esquerda" | "direita"; sheet: string; rowNumber: number; values: Record<string, string> }>;
  warnings: string[];
};

type CrossCheckState = {
  leftSourceId: string;
  rightSourceId: string;
  state: AsyncState;
  result: CrossCheckRun | null;
};

type DatabaseSource = {
  id: string;
  category: string;
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
  evidence_fragments: Array<{ reference: string; content: string; ordinal: number }> | null;
};

const SUPABASE_CONFIGURED = isSupabaseConfigured();

const crossCheckDefinitions: CrossCheckDefinition[] = [
  { id: "accounting-cashflow", label: "Contábil × Financeiro", leftCategory: "accounting", rightCategory: "cashflow", keys: ["data", "documento", "conta", "valor", "natureza"] },
  { id: "costs-production", label: "Custos × Produção", leftCategory: "costs", rightCategory: "production", keys: ["empresa", "fazenda", "safra", "cultura", "talhao", "centroCusto"] },
  { id: "commercial-inventory", label: "Comercial × Estoque", leftCategory: "commercial", rightCategory: "inventory", keys: ["produto", "quantidade", "valor"] },
  { id: "debt-cashflow", label: "Dívida × Fluxo de caixa", leftCategory: "cashflow", rightCategory: "cashflow", keys: ["credor", "vencimento", "moeda", "valor"] },
];

function createCrossCheckState(): Record<string, CrossCheckState> {
  return Object.fromEntries(
    crossCheckDefinitions.map((definition) => [
      definition.id,
      { leftSourceId: "", rightSourceId: "", state: "idle", result: null },
    ]),
  );
}

const navigation: Array<{ id: View; label: string; icon: string; detail: string }> = [
  { id: "overview", label: "Central", icon: "◈", detail: "visão de prontidão" },
  { id: "ingestion", label: "Base documental", icon: "↥", detail: "upload e extração" },
  { id: "crosscheck", label: "Cruzamentos", icon: "⇄", detail: "chaves e consistência" },
  { id: "scenarios", label: "Cenários", icon: "⌁", detail: "fluxo e osciladores" },
  { id: "report", label: "Relatório", icon: "▤", detail: "IA e exportação" },
];

const financialFields: Array<{ key: keyof FinancialBase; label: string; helper: string }> = [
  { key: "openingCash", label: "Caixa inicial", helper: "saldo de abertura do período simulado" },
  { key: "cashReceipts", label: "Recebimentos previstos", helper: "entradas previstas no período" },
  { key: "revenue", label: "Receita prevista", helper: "base para margem e resultado" },
  { key: "operatingCosts", label: "Custos operacionais", helper: "OPEX da safra, sem CAPEX" },
  { key: "financialExpenses", label: "Despesas financeiras", helper: "juros e encargos previstos" },
  { key: "debtServiceDomestic", label: "Serviço de dívida nacional", helper: "amortização + juros em R$" },
  { key: "debtServiceForeign", label: "Serviço de dívida em moeda estrangeira", helper: "parcela exposta ao câmbio" },
  { key: "capex", label: "Investimentos / CAPEX", helper: "expansão, infraestrutura e ativos" },
];

function parseNumeric(value: string) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCurrency(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function extractionLabel(source: ExtractedSource) {
  const labels: Record<ExtractedSource["extractionMethod"], string> = {
    structured: "Estruturada",
    text: "Texto extraído",
    ocr: "OCR",
    "manual-review": "Revisão manual",
  };
  return labels[source.extractionMethod];
}

function statusLabel(status: ExtractedSource["status"]) {
  const labels: Record<ExtractedSource["status"], string> = {
    processing: "Processando",
    ready: "Pronto",
    "needs-review": "Revisar",
    failed: "Falhou",
  };
  return labels[status];
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapDatabaseSource(source: DatabaseSource): ExtractedSource {
  const extractionMethod = (source.extraction_method ?? "manual_review").replace("_", "-") as ExtractedSource["extractionMethod"];
  const statusMap: Record<string, ExtractedSource["status"]> = {
    queued: "processing",
    processing: "processing",
    ready: "ready",
    needs_review: "needs-review",
    failed: "failed",
  };
  return {
    id: source.id,
    category: source.category as DataCategoryId,
    fileName: source.original_name,
    storagePath: source.storage_path,
    mimeType: source.mime_type,
    size: source.byte_size,
    status: statusMap[source.extraction_status] ?? "failed",
    extractionMethod,
    recordCount: source.record_count,
    columns: stringArray(source.columns_json),
    previewRows: Array.isArray(source.preview_json) ? (source.preview_json as ExtractedSource["previewRows"]) : [],
    evidence: (source.evidence_fragments ?? [])
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((item) => ({ reference: item.reference, text: item.content })),
    warnings: stringArray(source.warnings_json),
    importedAt: source.created_at,
  };
}

function sourceUploadAccepts() {
  return ".xlsx,.xls,.csv,.pdf,.docx,.txt,.png,.jpg,.jpeg,.webp";
}

const uploadMimeTypes: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function uploadMimeType(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const fallback = uploadMimeTypes[extension];
  if (!fallback) return null;
  return fallback;
}

function safeFileName(fileName: string) {
  return fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(-120);
}

export function AnalysisDashboard() {
  const [activeView, setActiveView] = useState<View>("overview");
  const [sources, setSources] = useState<ExtractedSource[]>([]);
  const [simulation, setSimulation] = useState<SimulationInput>(createEmptySimulationInput);
  const [uploadState, setUploadState] = useState<Record<string, AsyncState>>({});
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [securityState, setSecurityState] = useState<SecurityState>(SUPABASE_CONFIGURED ? "checking" : "unconfigured");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [emailToSignIn, setEmailToSignIn] = useState("");
  const [authState, setAuthState] = useState<AsyncState>("idle");
  const [crossCheckState, setCrossCheckState] = useState<Record<string, CrossCheckState>>(createCrossCheckState);
  const [message, setMessage] = useState(
    SUPABASE_CONFIGURED
      ? "Aguardando fontes oficiais para iniciar a análise."
      : "A conexão segura ainda não foi configurada. Nenhum arquivo pode ser enviado sem Storage privado.",
  );
  const [analysis, setAnalysis] = useState<AiAnalysisResult | null>(null);
  const [analysisState, setAnalysisState] = useState<AsyncState>("idle");
  const [exportState, setExportState] = useState<AsyncState>("idle");

  useEffect(() => {
    if (!SUPABASE_CONFIGURED) {
      return;
    }

    let active = true;
    async function initializeSecureWorkspace() {
      try {
        const supabase = createSupabaseBrowserClient();
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (!sessionData.session) {
          if (active) {
            setSecurityState("signed-out");
            setMessage("Acesse com seu e-mail para criar um espaço privado e persistente para os documentos.");
          }
          return;
        }
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (userError) throw userError;
        if (!userData.user) {
          if (active) {
            setSecurityState("signed-out");
            setMessage("Acesse com seu e-mail para criar um espaço privado e persistente para os documentos.");
          }
          return;
        }

        const user = userData.user;
        const { data: existingWorkspace, error: workspaceReadError } = await supabase
          .from("analysis_workspaces")
          .select("id")
          .eq("owner_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (workspaceReadError) throw workspaceReadError;

        let nextWorkspaceId = existingWorkspace?.id ?? null;
        if (!nextWorkspaceId) {
          const { data: createdWorkspace, error: workspaceCreateError } = await supabase
            .from("analysis_workspaces")
            .insert({ owner_id: user.id, name: "Análise atual", company_name: "Grupo Zancanaro" })
            .select("id")
            .single();
          if (workspaceCreateError || !createdWorkspace) throw workspaceCreateError ?? new Error("Não foi possível criar o espaço de análise.");
          nextWorkspaceId = createdWorkspace.id;
        }

        const { data: storedSources, error: sourceReadError } = await supabase
          .from("source_files")
          .select("id, category, original_name, storage_path, mime_type, byte_size, extraction_status, extraction_method, record_count, columns_json, preview_json, warnings_json, created_at, evidence_fragments(reference, content, ordinal)")
          .eq("workspace_id", nextWorkspaceId)
          .order("created_at", { ascending: false });
        if (sourceReadError) throw sourceReadError;

        if (active) {
          setSources(((storedSources ?? []) as DatabaseSource[]).map(mapDatabaseSource));
          setWorkspaceId(nextWorkspaceId);
          setUserId(user.id);
          setUserEmail(user.email ?? null);
          setSecurityState("ready");
          setMessage("Espaço privado conectado. Envie fontes oficiais; nada será preenchido com dados fictícios.");
        }
      } catch {
        if (active) {
          setSecurityState("error");
          setMessage("Não foi possível preparar o espaço seguro. Confira a conexão Supabase e tente atualizar a página.");
        }
      }
    }

    void initializeSecureWorkspace();
    return () => {
      active = false;
    };
  }, []);

  const scenarioResults = useMemo(() => calculateAllScenarios(simulation), [simulation]);
  const missingRequirements = useMemo(() => getMissingSimulationRequirements(simulation), [simulation]);
  const scenarioReady = missingRequirements.length === 0;
  const categoriesLoaded = new Set(sources.map((source) => source.category));
  const readySources = sources.filter((source) => source.status === "ready").length;
  const reviewSources = sources.filter((source) => source.status === "needs-review").length;
  const structuredSources = sources.filter((source) => source.extractionMethod === "structured").length;

  function updateUploadTask(id: string, update: Partial<UploadTask>) {
    setUploadTasks((current) => current.map((task) => (task.id === id ? { ...task, ...update } : task)));
  }

  async function sendMagicLink() {
    if (!SUPABASE_CONFIGURED) return;
    const email = emailToSignIn.trim();
    if (!email) {
      setAuthState("error");
      setMessage("Informe seu e-mail corporativo para receber o link de acesso.");
      return;
    }

    setAuthState("working");
    try {
      const supabase = createSupabaseBrowserClient();
      const redirect = new URL("/auth/callback", window.location.origin).toString();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirect, shouldCreateUser: true },
      });
      if (error) throw error;
      setAuthState("done");
      setMessage("Link seguro enviado. Abra-o no mesmo navegador para acessar o espaço privado.");
    } catch (error) {
      setAuthState("error");
      setMessage(error instanceof Error ? error.message : "Não foi possível enviar o link de acesso.");
    }
  }

  async function signOut() {
    if (!SUPABASE_CONFIGURED) return;
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    setSources([]);
    setWorkspaceId(null);
    setUserId(null);
    setUserEmail(null);
    setSecurityState("signed-out");
    setMessage("Sessão encerrada. Seus arquivos continuam guardados no espaço privado da sua conta.");
  }

  async function uploadFiles(category: DataCategoryId, files: File[]) {
    if (files.length === 0) return;
    if (securityState !== "ready" || !workspaceId || !userId) {
      setMessage("Acesse o espaço seguro antes de enviar arquivos corporativos.");
      return;
    }

    setUploadState((current) => ({ ...current, [category]: "working" }));
    setMessage(`Enviando e extraindo ${files.length} arquivo(s) em ${DATA_CATEGORIES.find((item) => item.id === category)?.shortLabel ?? category}…`);
    const tasks = files.map((file) => ({ id: crypto.randomUUID(), fileName: file.name, category, state: "uploading" as const }));
    setUploadTasks((current) => [...tasks, ...current]);

    const outcomes = await Promise.allSettled(
      files.map(async (file, index) => {
        const task = tasks[index];
        if (file.size === 0 || file.size > 25 * 1024 * 1024) {
          throw new Error(`${file.name} deve ter entre 1 byte e 25 MB.`);
        }
        const mimeType = uploadMimeType(file);
        if (!mimeType) {
          throw new Error(`${file.name} não possui um formato aceito. Use XLSX, XLS, CSV, PDF, DOCX, TXT ou imagem PNG/JPG/WebP.`);
        }

        const supabase = createSupabaseBrowserClient();
        const storagePath = `${userId}/${workspaceId}/${task.id}-${safeFileName(file.name)}`;
        const { error: uploadError } = await supabase.storage.from("agro-analysis-files").upload(storagePath, file, {
          contentType: mimeType,
          upsert: false,
        });
        if (uploadError) throw uploadError;

        const { data: storedSource, error: sourceError } = await supabase
          .from("source_files")
          .insert({
            workspace_id: workspaceId,
            uploaded_by: userId,
            category,
            original_name: file.name,
            storage_path: storagePath,
            mime_type: mimeType,
            byte_size: file.size,
            extraction_status: "queued",
          })
          .select("id")
          .single();
        if (sourceError || !storedSource) {
          await supabase.storage.from("agro-analysis-files").remove([storagePath]);
          throw sourceError ?? new Error("Não foi possível registrar o arquivo.");
        }

        updateUploadTask(task.id, { state: "extracting" });
        const response = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceFileId: storedSource.id }),
        });
        const payload = (await response.json()) as { source?: ExtractedSource; error?: string };
        if (!response.ok || !payload.source) throw new Error(payload.error ?? `Não foi possível extrair ${file.name}.`);
        updateUploadTask(task.id, { state: "ready" });
        return payload.source;
      }),
    );

    const successful = outcomes
      .filter((result): result is PromiseFulfilledResult<ExtractedSource> => result.status === "fulfilled")
      .map((result) => result.value);
    const failures = outcomes.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "rejected") {
        updateUploadTask(tasks[index].id, {
          state: "error",
          error: outcome.reason instanceof Error ? outcome.reason.message : "Falha no envio.",
        });
      }
    });

    if (successful.length > 0) {
      setSources((current) => [...successful, ...current]);
    }
    setUploadState((current) => ({ ...current, [category]: successful.length > 0 ? "done" : "error" }));
    const needsReview = successful.filter((source) => source.status === "needs-review").length;
    setMessage(
      failures.length > 0
        ? `${successful.length} arquivo(s) concluído(s) e ${failures.length} com falha. Cada falha permanece identificada na fila.`
        : needsReview > 0
          ? `${successful.length} arquivo(s) persistido(s); ${needsReview} requer(em) revisão antes de entrar em cálculos.`
          : `${successful.length} arquivo(s) persistido(s) e disponível(is) para mapeamento.`,
    );
  }

  async function handleInputUpload(category: DataCategoryId, event: ChangeEvent<HTMLInputElement>) {
    try {
      await uploadFiles(category, Array.from(event.target.files ?? []));
    } finally {
      event.target.value = "";
    }
  }

  async function handleDrop(category: DataCategoryId, event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    await uploadFiles(category, Array.from(event.dataTransfer.files));
  }

  function updateBase(key: keyof FinancialBase, rawValue: string) {
    setSimulation((current) => ({
      ...current,
      base: { ...current.base, [key]: parseNumeric(rawValue) },
    }));
  }

  function updateAssumptionValue(driver: DriverId, scenario: ScenarioKey, rawValue: string) {
    setSimulation((current) => ({
      ...current,
      assumptions: {
        ...current.assumptions,
        [driver]: {
          ...current.assumptions[driver],
          values: { ...current.assumptions[driver].values, [scenario]: parseNumeric(rawValue) },
        },
      },
    }));
  }

  function updateAssumptionSource(driver: DriverId, sourceId: string | null) {
    setSimulation((current) => ({
      ...current,
      assumptions: {
        ...current.assumptions,
        [driver]: { ...current.assumptions[driver], sourceId },
      },
    }));
  }

  function updateAssumptionReference(driver: DriverId, reference: string) {
    setSimulation((current) => ({
      ...current,
      assumptions: {
        ...current.assumptions,
        [driver]: { ...current.assumptions[driver], reference },
      },
    }));
  }

  async function removeSource(source: ExtractedSource) {
    if (securityState !== "ready") return;
    try {
      const supabase = createSupabaseBrowserClient();
      if (source.storagePath) {
        const { error: storageError } = await supabase.storage.from("agro-analysis-files").remove([source.storagePath]);
        if (storageError) throw storageError;
      }
      const { error } = await supabase.from("source_files").delete().eq("id", source.id);
      if (error) throw error;
      setSources((current) => current.filter((item) => item.id !== source.id));
      setMessage(`${source.fileName} foi removido do espaço de análise.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível remover o arquivo.");
    }
  }

  function updateCrossCheckSources(id: string, field: "leftSourceId" | "rightSourceId", value: string) {
    setCrossCheckState((current) => ({
      ...current,
      [id]: { ...current[id], [field]: value, result: null, state: "idle" },
    }));
  }

  async function runCrossCheck(definition: CrossCheckDefinition) {
    const current = crossCheckState[definition.id];
    if (!workspaceId || securityState !== "ready") {
      setMessage("Acesse o espaço seguro antes de executar cruzamentos.");
      return;
    }
    if (!current.leftSourceId || !current.rightSourceId) {
      setMessage(`Selecione os dois arquivos para ${definition.label}.`);
      return;
    }

    setCrossCheckState((state) => ({ ...state, [definition.id]: { ...state[definition.id], state: "working" } }));
    setMessage(`Cruzando ${definition.label} com as chaves selecionadas…`);
    try {
      const response = await fetch("/api/crosscheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          leftSourceId: current.leftSourceId,
          rightSourceId: current.rightSourceId,
          keys: definition.keys,
        }),
      });
      const payload = (await response.json()) as CrossCheckRun & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Não foi possível executar o cruzamento.");
      setCrossCheckState((state) => ({ ...state, [definition.id]: { ...state[definition.id], state: "done", result: payload } }));
      setMessage(`${definition.label}: ${payload.matched.toLocaleString("pt-BR")} correspondência(s) real(is) encontrada(s). Revise as amostras e as chaves mapeadas.`);
    } catch (error) {
      setCrossCheckState((state) => ({ ...state, [definition.id]: { ...state[definition.id], state: "error" } }));
      setMessage(error instanceof Error ? error.message : "Falha no cruzamento.");
    }
  }

  async function runAiAnalysis() {
    if (sources.length === 0 || !workspaceId || securityState !== "ready") {
      setAnalysisState("error");
      setMessage("Envie fontes e acesse o espaço seguro antes de solicitar a leitura assistida por IA.");
      return;
    }

    setAnalysisState("working");
    setMessage("A IA está revisando somente as evidências e cálculos disponíveis…");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          sourceIds: sources.map((source) => source.id),
          baseline: {
            sourceId: simulation.baseSourceId,
            reference: simulation.baseReference,
          },
          financialBase: simulation.base,
          scenarioAssumptions: Object.fromEntries(
            DRIVER_DEFINITIONS.map((driver) => {
              const assumption = simulation.assumptions[driver.id];
              return [
                driver.id,
                {
                  values: assumption.values,
                  sourceId: assumption.sourceId,
                  reference: assumption.reference,
                },
              ];
            }),
          ),
          scenarioResults,
        }),
      });
      const payload = (await response.json()) as { analysis?: AiAnalysisResult; error?: string };
      if (!response.ok || !payload.analysis) {
        throw new Error(payload.error ?? "Não foi possível concluir a análise assistida.");
      }
      setAnalysis(payload.analysis);
      setAnalysisState("done");
      setMessage("Leitura assistida concluída. Revise fatos, inferências, recomendações e lacunas antes de exportar.");
    } catch (error) {
      setAnalysisState("error");
      setMessage(error instanceof Error ? error.message : "Falha ao executar a leitura assistida.");
    }
  }

  async function downloadReport() {
    if (!scenarioReady || !workspaceId || securityState !== "ready") {
      setExportState("error");
      setMessage("Acesse o espaço seguro e complete os valores-base e a rastreabilidade das premissas antes de exportar.");
      return;
    }

    setExportState("working");
    setMessage("Gerando o relatório comparativo em .docx…");
    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generatedAt: new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(new Date()),
          workspaceId,
          sourceIds: sources.map((source) => source.id),
          baseSourceId: simulation.baseSourceId,
          baseReference: simulation.baseReference,
          assumptions: DRIVER_DEFINITIONS.map((driver) => {
            const assumption = simulation.assumptions[driver.id];
            return {
              label: driver.label,
              sourceId: assumption.sourceId,
              reference: assumption.reference,
              pessimistic: assumption.values.pessimistic ?? 0,
              normal: assumption.values.normal ?? 0,
              optimistic: assumption.values.optimistic ?? 0,
            };
          }),
          scenarios: {
            pessimistic: { ...scenarioResults.pessimistic, label: "Pessimista" },
            normal: { ...scenarioResults.normal, label: "Normal" },
            optimistic: { ...scenarioResults.optimistic, label: "Otimista" },
          },
          analysis,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "Não foi possível gerar o relatório.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "analise-comparativa-cenarios.docx";
      link.click();
      URL.revokeObjectURL(url);
      setExportState("done");
      setMessage("Relatório comparativo baixado. O documento registra fontes, premissas, cenários e limites de interpretação.");
    } catch (error) {
      setExportState("error");
      setMessage(error instanceof Error ? error.message : "Falha na exportação do relatório.");
    }
  }

  const crossChecks = crossCheckDefinitions.map((definition) => {
    const leftCount = sources.filter((source) => source.category === definition.leftCategory && source.extractionMethod === "structured").length;
    const rightCount = sources.filter((source) => source.category === definition.rightCategory && source.extractionMethod === "structured").length;
    const ready = definition.leftCategory === definition.rightCategory ? leftCount >= 2 : leftCount > 0 && rightCount > 0;
    return { ...definition, keysLabel: definition.keys.join(", "), ready };
  });

  return (
    <div className="app-shell">
      <aside className="side-panel">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">↗</div>
          <div>
            <div className="brand-kicker">GRUPO AGRÍCOLA</div>
            <div className="brand-name">Vértice</div>
          </div>
        </div>

        <div className="side-caption">Análise integrada</div>
        <nav className="side-nav" aria-label="Módulos da análise">
          {navigation.map((item) => (
            <button
              type="button"
              className={`nav-item ${activeView === item.id ? "is-active" : ""}`}
              key={item.id}
              onClick={() => setActiveView(item.id)}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className="side-foot">
          <span className="side-foot-dot" aria-hidden="true" />
          <p>Dados privados por padrão. A versão conectada usa Supabase com RLS e bucket não público.</p>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">INTELIGÊNCIA CORPORATIVA AGRÍCOLA</p>
            <h1>Centro de análise</h1>
          </div>
          <div className="top-actions">
            <span className={`environment-pill ${securityState === "ready" ? "is-connected" : ""}`} title={userEmail ?? undefined}>
              <span /> {securityState === "ready" ? "Espaço privado conectado" : securityState === "checking" ? "Conectando espaço seguro" : "Acesso necessário"}
            </span>
            {securityState === "ready" && <button className="quiet-action" type="button" onClick={() => void signOut()}>Sair</button>}
            <button className="primary-action" type="button" onClick={() => setActiveView("ingestion")} disabled={securityState !== "ready"}>Adicionar fontes <span aria-hidden="true">→</span></button>
          </div>
        </header>

        <div className="status-line" role="status" aria-live="polite">
          <span className="status-spark" aria-hidden="true">✦</span>
          {message}
        </div>

        {activeView === "overview" && (
          <section className="view-stack">
            <div className="hero-panel">
              <div className="hero-copy">
                <p className="hero-eyebrow">BASE DOCUMENTAL → CENÁRIOS AUDITÁVEIS</p>
                <h2>Decida com rastreabilidade, não com estimativas inventadas.</h2>
                <p>Centralize arquivos, extraia dados, valide cruzamentos e modele cenários pessimista, normal e otimista com cada oscilador ligado à sua evidência.</p>
                <div className="hero-actions">
                  <button className="primary-action" type="button" onClick={() => setActiveView("ingestion")}>Começar pela base documental <span aria-hidden="true">→</span></button>
                  <button className="quiet-action" type="button" onClick={() => setActiveView("scenarios")}>Ver simulador</button>
                </div>
              </div>
              <div className="hero-logic" aria-label="Fluxo da análise">
                <div className="logic-node is-live"><span>01</span><strong>Fontes</strong><small>arquivo + origem</small></div>
                <div className="logic-line" />
                <div className="logic-node"><span>02</span><strong>Validação</strong><small>chaves + consistência</small></div>
                <div className="logic-line" />
                <div className="logic-node"><span>03</span><strong>Cenários</strong><small>premissas rastreáveis</small></div>
              </div>
            </div>

            <div className="metric-grid">
              <MetricCard label="Fontes carregadas" value={String(sources.length)} note={`${readySources} prontas · ${reviewSources} para revisão`} tone="green" />
              <MetricCard label="Dados estruturados" value={String(structuredSources)} note="planilhas e CSVs com prévia" tone="blue" />
              <MetricCard label="Cruzamentos habilitados" value={`${crossChecks.filter((item) => item.ready).length}/${crossChecks.length}`} note="ainda exigem mapeamento de chaves" tone="amber" />
              <MetricCard label="Cenários calculáveis" value={scenarioReady ? "3/3" : "0/3"} note={scenarioReady ? "premissas documentadas" : "complete a base e as fontes"} tone="slate" />
            </div>

            <div className="two-column-layout">
              <article className="panel evidence-panel">
                <div className="panel-heading">
                  <div>
                    <p className="section-kicker">PRÓXIMO PASSO</p>
                    <h3>O que sustenta uma análise confiável</h3>
                  </div>
                  <button type="button" className="text-button" onClick={() => setActiveView("ingestion")}>Abrir uploads →</button>
                </div>
                <div className="evidence-checklist">
                  {[
                    ["Estrutura mestre", "empresa, fazenda, safra, cultura, talhão e centro de custo", categoriesLoaded.has("structure")],
                    ["Base econômica", "DRE, fluxo de caixa, dívida, custos e orçamento", categoriesLoaded.has("cashflow") && categoriesLoaded.has("costs")],
                    ["Base operacional", "produção, área, produtividade, operações e perdas", categoriesLoaded.has("production")],
                    ["Base comercial", "vendas, contratos, preços, estoque e compromissos", categoriesLoaded.has("commercial") && categoriesLoaded.has("inventory")],
                  ].map(([title, detail, complete]) => (
                    <div className="check-item" key={String(title)}>
                      <span className={`check-dot ${complete ? "is-complete" : ""}`} aria-hidden="true">{complete ? "✓" : ""}</span>
                      <div><strong>{title}</strong><small>{detail}</small></div>
                    </div>
                  ))}
                </div>
              </article>

              <article className="panel method-panel">
                <p className="section-kicker">GUARDRAIL DE IA</p>
                <h3>Quatro camadas de rigor</h3>
                <ol className="method-list">
                  <li><span>1</span><p><strong>Fato</strong> — dado localizado em arquivo, aba, página ou trecho.</p></li>
                  <li><span>2</span><p><strong>Inferência</strong> — leitura derivada, com limitação explícita.</p></li>
                  <li><span>3</span><p><strong>Recomendação</strong> — somente quando a evidência for suficiente.</p></li>
                  <li><span>4</span><p><strong>Lacuna</strong> — ausência de dados nunca é preenchida automaticamente.</p></li>
                </ol>
              </article>
            </div>
          </section>
        )}

        {activeView === "ingestion" && (
          <section className="view-stack">
            <div className="view-heading">
              <div>
                <p className="section-kicker">ETAPA 1 · INGESTÃO E OCR</p>
                <h2>Organize a evidência antes de analisar.</h2>
                <p>Cada grupo de arquivos tem um destino claro. XLSX e CSV preservam colunas; PDF e DOCX extraem texto; imagens passam por OCR e entram sempre com revisão humana.</p>
              </div>
              <div className="info-badge">Limite operacional: 25 MB por arquivo</div>
            </div>

            {securityState !== "ready" ? (
              <article className="panel secure-access-panel">
                <p className="section-kicker">ACESSO E PERSISTÊNCIA</p>
                {securityState === "unconfigured" ? (
                  <>
                    <h3>Conexão segura ainda não configurada</h3>
                    <p>O aplicativo não aceita documentos corporativos até que o Storage privado e as políticas de acesso estejam ativos.</p>
                  </>
                ) : securityState === "checking" ? (
                  <>
                    <h3>Preparando seu espaço privado</h3>
                    <p>Conferindo autenticação e acesso ao Storage seguro…</p>
                  </>
                ) : securityState === "error" ? (
                  <>
                    <h3>Não foi possível abrir o espaço privado</h3>
                    <p>Atualize a página após conferir a conexão do projeto Supabase. Nenhum dado foi enviado.</p>
                  </>
                ) : (
                  <>
                    <h3>Acesse para enviar documentos</h3>
                    <p>O link de acesso cria uma sessão vinculada ao seu e-mail. Cada arquivo ficará em bucket privado, protegido por regras de acesso.</p>
                    <div className="secure-access-form">
                      <label className="field wide-field"><span>E-mail corporativo</span><input type="email" value={emailToSignIn} onChange={(event) => setEmailToSignIn(event.target.value)} placeholder="voce@empresa.com.br" autoComplete="email" /></label>
                      <button className="primary-action" type="button" onClick={() => void sendMagicLink()} disabled={authState === "working"}>{authState === "working" ? "Enviando link…" : authState === "done" ? "Link enviado" : "Enviar link seguro"}</button>
                    </div>
                  </>
                )}
              </article>
            ) : (
              <>
                <div className="upload-grid">
                  {DATA_CATEGORIES.map((category, index) => (
                    <label
                      className={`upload-card ${uploadState[category.id] === "working" ? "is-uploading" : ""}`}
                      htmlFor={`file-${category.id}`}
                      key={category.id}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => void handleDrop(category.id, event)}
                    >
                      <input
                        id={`file-${category.id}`}
                        type="file"
                        multiple
                        className="sr-only"
                        accept={sourceUploadAccepts()}
                        onChange={(event) => void handleInputUpload(category.id, event)}
                      />
                      <div className="upload-topline">
                        <span className="upload-index">0{index + 1}</span>
                        <span className={`upload-state ${categoriesLoaded.has(category.id) ? "is-loaded" : ""}`}>{categoriesLoaded.has(category.id) ? "Carregado" : "Aguardando"}</span>
                      </div>
                      <div className="upload-icon" aria-hidden="true">{category.id === "cashflow" ? "∿" : category.id === "production" ? "◌" : "＋"}</div>
                      <h3>{category.label}</h3>
                      <p>{category.description}</p>
                      <div className="upload-footer"><span>{category.accepts.join(" · ")}</span><strong>Selecionar arquivos</strong></div>
                    </label>
                  ))}
                </div>

                {uploadTasks.length > 0 && <div className="upload-queue" aria-live="polite">{uploadTasks.slice(0, 12).map((task) => <div className={`upload-queue-row ${task.state}`} key={task.id}><span>{task.state === "ready" ? "✓" : task.state === "error" ? "!" : "…"}</span><strong>{task.fileName}</strong><small>{task.state === "uploading" ? "Enviando ao Storage privado" : task.state === "extracting" ? "Extraindo e indexando" : task.state === "ready" ? "Concluído" : task.error ?? "Falhou"}</small></div>)}</div>}
              </>
            )}

            <article className="panel source-table-panel">
              <div className="panel-heading">
                <div><p className="section-kicker">EXTRAÇÕES</p><h3>Fontes carregadas</h3></div>
                <span className="count-pill">{sources.length} arquivo(s)</span>
              </div>
              {sources.length === 0 ? (
                <EmptyState title="Nenhuma fonte carregada" text="Envie arquivos acima. Nenhum número de demonstração é usado nesta aplicação." />
              ) : (
                <div className="source-list">
                  {sources.map((source) => (
                    <article className="source-row" key={source.id}>
                      <div className="file-glyph" aria-hidden="true">{source.extractionMethod === "structured" ? "▦" : source.extractionMethod === "ocr" ? "◫" : "▤"}</div>
                      <div className="source-main">
                        <strong>{source.fileName}</strong>
                        <span>{DATA_CATEGORIES.find((item) => item.id === source.category)?.label} · {formatBytes(source.size)} · {extractionLabel(source)}</span>
                      </div>
                      <div className="source-evidence"><strong>{source.recordCount > 0 ? source.recordCount.toLocaleString("pt-BR") : source.evidence.length}</strong><span>{source.recordCount > 0 ? "registros" : "trechos"}</span></div>
                      <span className={`source-status ${source.status}`}>{statusLabel(source.status)}</span>
                      {securityState === "ready" && <button className="source-remove" type="button" onClick={() => void removeSource(source)}>Remover</button>}
                      {source.warnings.length > 0 && <p className="source-warning">{source.warnings[0]}</p>}
                    </article>
                  ))}
                </div>
              )}
            </article>
          </section>
        )}

        {activeView === "crosscheck" && (
          <section className="view-stack">
            <div className="view-heading">
              <div>
                <p className="section-kicker">ETAPA 2 · QUALIDADE E CRUZAMENTOS</p>
                <h2>Concilie por chaves, nunca por impressão visual.</h2>
                <p>O sistema só libera um cruzamento para decisão quando os dois lados estão presentes e as chaves são definidas pelo usuário.</p>
              </div>
            </div>
            <div className="crosscheck-grid">
              <article className="panel match-panel">
                <div className="panel-heading"><div><p className="section-kicker">MAPA DE RELAÇÕES</p><h3>Cruzamentos executáveis</h3></div><span className="count-pill">matching por chaves rastreáveis</span></div>
                <div className="match-list">
                  {crossChecks.map((check) => {
                    const currentRun = crossCheckState[check.id];
                    return <article className="match-run" key={check.id}>
                      <div className="match-run-heading"><div><strong>{check.label}</strong><small>Chaves: {check.keysLabel}</small></div><span className={`match-label ${check.ready ? "is-ready" : ""}`}>{check.ready ? "Pronto" : "Aguardando planilhas"}</span></div>
                      {check.ready && <>
                        <div className="match-source-selects">
                          <label><span>Fonte A</span><select value={currentRun.leftSourceId} onChange={(event) => updateCrossCheckSources(check.id, "leftSourceId", event.target.value)}><option value="">Selecione</option>{sources.filter((source) => source.category === check.leftCategory && source.extractionMethod === "structured").map((source) => <option key={source.id} value={source.id}>{source.fileName}</option>)}</select></label>
                          <label><span>Fonte B</span><select value={currentRun.rightSourceId} onChange={(event) => updateCrossCheckSources(check.id, "rightSourceId", event.target.value)}><option value="">Selecione</option>{sources.filter((source) => source.category === check.rightCategory && source.extractionMethod === "structured").map((source) => <option key={source.id} value={source.id}>{source.fileName}</option>)}</select></label>
                          <button type="button" className="text-button" onClick={() => void runCrossCheck(check)} disabled={currentRun.state === "working"}>{currentRun.state === "working" ? "Cruzando…" : "Executar cruzamento →"}</button>
                        </div>
                        {currentRun.result && <CrossCheckResultBlock result={currentRun.result} />}
                      </>}
                    </article>
                  })}
                </div>
              </article>
              <article className="panel quality-panel">
                <p className="section-kicker">CONTROLE DE QUALIDADE</p>
                <h3>Verificações ativas</h3>
                <div className="quality-list">
                  <QualityLine label="Arquivos estruturados identificados" state={structuredSources > 0 ? "ok" : "pending"} detail={structuredSources > 0 ? `${structuredSources} com prévia de colunas` : "envie XLSX ou CSV"} />
                  <QualityLine label="OCR revisado" state={reviewSources === 0 && sources.length > 0 ? "ok" : "pending"} detail={reviewSources === 0 && sources.length > 0 ? "sem alertas pendentes" : `${reviewSources} arquivo(s) requer(em) conferência`} />
                  <QualityLine label="Base financeira disponível" state={categoriesLoaded.has("cashflow") ? "ok" : "pending"} detail={categoriesLoaded.has("cashflow") ? "fluxo/dívida carregados" : "envie fluxo de caixa e dívida"} />
                  <QualityLine label="Fonte de cenário selecionada" state={simulation.baseSourceId ? "ok" : "pending"} detail={simulation.baseSourceId ? "base vinculada" : "selecione em Cenários"} />
                </div>
              </article>
            </div>

            <article className="panel process-note">
              <div className="process-note-icon" aria-hidden="true">!</div>
              <div><strong>Regra de integridade</strong><p>Transferências, estornos, reclassificações e movimentações internas precisam ser marcados antes do matching. O sistema não deve sugerir conciliação quando a própria origem já identifica reversão ou ausência de contraparte.</p></div>
            </article>
          </section>
        )}

        {activeView === "scenarios" && (
          <section className="view-stack">
            <div className="view-heading">
              <div>
                <p className="section-kicker">ETAPA 3 · CENÁRIOS E FLUXO</p>
                <h2>Modele o efeito das variáveis sem criar uma previsão fictícia.</h2>
                <p>Os indicadores vêm das fontes fornecidas: preço de commodities, produtividade/clima, custos, juros e câmbio. Informe a variação e a referência que a sustenta.</p>
              </div>
              <span className={`scenario-ready-badge ${scenarioReady ? "is-ready" : ""}`}>{scenarioReady ? "Simulador validado" : "Premissas pendentes"}</span>
            </div>

            <article className="panel baseline-panel">
              <div className="panel-heading"><div><p className="section-kicker">BASE ECONÔMICA DO PERÍODO</p><h3>Valores de referência</h3></div><span className="panel-note">Informe valores consolidados no mesmo período e mesma unidade monetária.</span></div>
              <div className="reference-row">
                <label className="field wide-field"><span>Documento-base</span><select value={simulation.baseSourceId ?? ""} onChange={(event) => setSimulation((current) => ({ ...current, baseSourceId: event.target.value || null }))}><option value="">Selecione uma fonte carregada</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.fileName}</option>)}</select></label>
                <label className="field wide-field"><span>Referência exata</span><input value={simulation.baseReference} onChange={(event) => setSimulation((current) => ({ ...current, baseReference: event.target.value }))} placeholder="Ex.: DFC 2026, aba Fluxo, linhas 12–37" /></label>
              </div>
              <div className="base-field-grid">
                {financialFields.map((field) => (
                  <label className="field" key={field.key}>
                    <span>{field.label}</span>
                    <input type="number" inputMode="decimal" value={simulation.base[field.key] ?? ""} onChange={(event) => updateBase(field.key, event.target.value)} placeholder="R$ 0,00" />
                    <small>{field.helper}</small>
                  </label>
                ))}
              </div>
            </article>

            <article className="panel assumptions-panel">
              <div className="panel-heading"><div><p className="section-kicker">MATRIZ DE OSCILADORES</p><h3>Premissas por cenário</h3></div><span className="panel-note">Use percentuais relativos à base. Normal pode ser 0,0% quando a base já representar o cenário central.</span></div>
              <div className="assumption-table-wrap">
                <table className="assumption-table">
                  <thead><tr><th>Oscilador</th><th>Pessimista</th><th>Normal</th><th>Otimista</th><th>Fonte documental</th><th>Referência</th></tr></thead>
                  <tbody>
                    {DRIVER_DEFINITIONS.map((driver) => {
                      const assumption = simulation.assumptions[driver.id];
                      return <tr key={driver.id}>
                        <td><strong>{driver.label}</strong><small>{driver.description}<br />Impacto: {driver.appliesTo}</small></td>
                        {SCENARIO_KEYS.map((scenario) => <td key={scenario}><label className="compact-input"><input type="number" step="0.1" value={assumption.values[scenario] ?? ""} onChange={(event) => updateAssumptionValue(driver.id, scenario, event.target.value)} aria-label={`${driver.label} ${SCENARIO_LABELS[scenario]}`} /><span>%</span></label></td>)}
                        <td><select value={assumption.sourceId ?? ""} onChange={(event) => updateAssumptionSource(driver.id, event.target.value || null)} aria-label={`Fonte de ${driver.label}`}><option value="">Selecione</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.fileName}</option>)}</select></td>
                        <td><input value={assumption.reference} onChange={(event) => updateAssumptionReference(driver.id, event.target.value)} aria-label={`Referência de ${driver.label}`} placeholder="Aba, página ou trecho" /></td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            </article>

            {!scenarioReady && (
              <article className="requirement-banner"><span aria-hidden="true">↳</span><div><strong>O simulador permanece bloqueado até haver rastreabilidade.</strong><p>{missingRequirements.slice(0, 3).join(" ")}{missingRequirements.length > 3 ? ` + ${missingRequirements.length - 3} pendência(s).` : ""}</p></div></article>
            )}

            <div className="scenario-cards">
              {SCENARIO_KEYS.map((scenario) => {
                const result = scenarioResults[scenario];
                return <article className={`scenario-card scenario-${scenario}`} key={scenario}>
                  <div className="scenario-card-top"><span>{scenario === "pessimistic" ? "↓" : scenario === "normal" ? "•" : "↑"}</span><p>{SCENARIO_LABELS[scenario]}</p></div>
                  <div className="scenario-main-metric"><span>Caixa ao final</span><strong>{result.isCalculable ? formatCurrency(result.cashAtEnd) : "Aguardando base"}</strong></div>
                  <dl>
                    <div><dt>Resultado</dt><dd>{result.isCalculable ? formatCurrency(result.estimatedResult) : "—"}</dd></div>
                    <div><dt>Margem operacional</dt><dd>{result.isCalculable ? formatPercent(result.operatingMargin) : "—"}</dd></div>
                    <div><dt>Receita</dt><dd>{result.isCalculable ? formatCurrency(result.revenue) : "—"}</dd></div>
                  </dl>
                </article>;
              })}
            </div>

            <article className="panel flow-panel">
              <div className="panel-heading"><div><p className="section-kicker">PONTE DE FLUXO · CENÁRIO NORMAL</p><h3>Da entrada ao caixa final</h3></div><span className="panel-note">O fluxo só aparece após validação de todos os campos.</span></div>
              <div className="flow-bridge">
                <FlowStep label="Caixa inicial" value={scenarioResults.normal.isCalculable ? simulation.base.openingCash : null} type="opening" />
                <FlowStep label="Recebimentos" value={scenarioResults.normal.isCalculable ? scenarioResults.normal.cashReceipts : null} type="inflow" />
                <FlowStep label="Custos operacionais" value={scenarioResults.normal.isCalculable ? scenarioResults.normal.operatingCosts : null} type="outflow" />
                <FlowStep label="Dívida" value={scenarioResults.normal.isCalculable ? scenarioResults.normal.debtService : null} type="outflow" />
                <FlowStep label="CAPEX" value={scenarioResults.normal.isCalculable ? scenarioResults.normal.capex : null} type="outflow" />
                <FlowStep label="Caixa final" value={scenarioResults.normal.isCalculable ? scenarioResults.normal.cashAtEnd : null} type="final" />
              </div>
            </article>
          </section>
        )}

        {activeView === "report" && (
          <section className="view-stack">
            <div className="view-heading">
              <div><p className="section-kicker">ETAPA 4 · LEITURA E RELATÓRIO</p><h2>Consolide somente o que pode ser auditado.</h2><p>A IA estrutura achados em fatos, inferências, recomendações e lacunas. O arquivo final também preserva as premissas e fontes dos três cenários.</p></div>
            </div>
            <div className="report-grid">
              <article className="panel ai-panel">
                <div className="panel-heading"><div><p className="section-kicker">LEITURA ASSISTIDA</p><h3>IA com guarda-corpo documental</h3></div><span className={`ai-state ${analysisState}`}>{analysisState === "working" ? "Analisando" : analysisState === "done" ? "Concluída" : "Sob demanda"}</span></div>
                <p className="ai-intro">A IA receberá apenas trechos extraídos, nomes de arquivos, referências e cálculos já validados. Sem fonte, ela deve declarar lacuna.</p>
                <button className="primary-action" type="button" onClick={() => void runAiAnalysis()} disabled={analysisState === "working" || sources.length === 0}>{analysisState === "working" ? "Analisando evidências…" : "Gerar leitura assistida"} <span aria-hidden="true">→</span></button>
                {analysis ? <AiAnalysisBlock analysis={analysis} /> : <EmptyState title="Leitura ainda não gerada" text="Carregue fontes e clique em “Gerar leitura assistida”. Uma chave do AI Gateway é necessária no ambiente de produção." />}
              </article>
              <article className="panel export-panel">
                <p className="section-kicker">ENTREGA EXECUTIVA</p>
                <h3>Relatório comparativo em Word</h3>
                <p>Inclui a base documental, premissas, três cenários, ponte de fluxo, leitura por IA — se gerada — e limites de interpretação.</p>
                <div className="export-checks">
                  <CheckLine ok={sources.length > 0} text="Fontes anexadas" />
                  <CheckLine ok={Boolean(simulation.baseSourceId)} text="Valores-base com documento" />
                  <CheckLine ok={scenarioReady} text="Premissas com referência" />
                  <CheckLine ok={scenarioReady} text="Três cenários calculáveis" />
                </div>
                <button className="export-button" type="button" onClick={() => void downloadReport()} disabled={!scenarioReady || exportState === "working"}>{exportState === "working" ? "Gerando .docx…" : "Baixar análise comparativa (.docx)"} <span aria-hidden="true">↓</span></button>
                <small className="export-note">O relatório será bloqueado enquanto faltarem valores ou referências. Isso evita que uma simulação vire aparência de dado oficial.</small>
              </article>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function MetricCard({ label, value, note, tone }: { label: string; value: string; note: string; tone: string }) {
  return <article className={`metric-card tone-${tone}`}><p>{label}</p><strong>{value}</strong><span>{note}</span></article>;
}

function QualityLine({ label, state, detail }: { label: string; state: "ok" | "pending"; detail: string }) {
  return <div className="quality-line"><span className={`quality-dot ${state}`} aria-hidden="true">{state === "ok" ? "✓" : ""}</span><div><strong>{label}</strong><small>{detail}</small></div></div>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span aria-hidden="true">◌</span><div><strong>{title}</strong><p>{text}</p></div></div>;
}

function FlowStep({ label, value, type }: { label: string; value: number | null; type: string }) {
  return <div className={`flow-step ${type}`}><span>{label}</span><strong>{formatCurrency(value)}</strong></div>;
}

function CheckLine({ ok, text }: { ok: boolean; text: string }) {
  return <div className="check-line"><span className={ok ? "is-checked" : ""}>{ok ? "✓" : ""}</span>{text}</div>;
}

function AiAnalysisBlock({ analysis }: { analysis: AiAnalysisResult }) {
  return <div className="ai-result">
    <p className="ai-summary">{analysis.executiveSummary}</p>
    <div className="findings-list">
      {analysis.findings.map((finding, index) => <article className="finding" key={`${finding.title}-${index}`}><div className="finding-top"><span className={`classification ${finding.classification}`}>{finding.classification}</span><span className="confidence">{finding.confidence}% confiança</span></div><strong>{finding.title}</strong><p>{finding.explanation}</p><small>Fonte: {finding.evidence.join(" · ")}</small></article>)}
    </div>
    {analysis.dataGaps.length > 0 && <div className="gaps-box"><strong>Lacunas que permanecem</strong><ul>{analysis.dataGaps.map((gap, index) => <li key={`${gap}-${index}`}>{gap}</li>)}</ul></div>}
  </div>;
}

function CrossCheckResultBlock({ result }: { result: CrossCheckRun }) {
  return <div className="crosscheck-result">
    {result.missingKeys.length > 0 ? (
      <p className="crosscheck-warning">Não foi possível mapear automaticamente: {result.missingKeys.join(", ")}. Ajuste os cabeçalhos dos dois arquivos e execute novamente.</p>
    ) : (
      <>
        <div className="crosscheck-metrics"><span><strong>{result.matched.toLocaleString("pt-BR")}</strong> correspondências</span><span><strong>{result.leftUnmatched.toLocaleString("pt-BR")}</strong> só na fonte A</span><span><strong>{result.rightUnmatched.toLocaleString("pt-BR")}</strong> só na fonte B</span></div>
        <p className="crosscheck-mapping">Mapeamento usado: {result.mappings.map((item) => `${item.key}: ${item.leftColumn} ↔ ${item.rightColumn}`).join(" · ")}</p>
        {result.samples.length > 0 && <div className="crosscheck-samples"><strong>Amostras não correspondidas</strong>{result.samples.map((sample, index) => <small key={`${sample.side}-${sample.sheet}-${sample.rowNumber}-${index}`}>{sample.side}, {sample.sheet}, linha {sample.rowNumber}: {Object.entries(sample.values).map(([key, value]) => `${key}=${value || "—"}`).join(" · ")}</small>)}</div>}
      </>
    )}
    {result.warnings.map((warning, index) => <p className="crosscheck-warning" key={`${warning}-${index}`}>{warning}</p>)}
  </div>;
}
