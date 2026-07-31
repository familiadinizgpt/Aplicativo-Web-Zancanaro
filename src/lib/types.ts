export const DATA_CATEGORIES = [
  {
    id: "structure",
    label: "Cadastros e estrutura",
    shortLabel: "Estrutura",
    description:
      "Empresas, fazendas, safras, culturas, talhões, centros de custo e plano de contas.",
    requiredColumns: ["empresa", "fazenda", "safra", "cultura"],
    accepts: ["XLSX", "XLS", "CSV", "PDF", "DOCX"],
  },
  {
    id: "production",
    label: "Produção e operações",
    shortLabel: "Operações",
    description:
      "Área, produção, produtividade, operações, irrigação, insumos, frota e perdas.",
    requiredColumns: ["data", "fazenda", "cultura", "talhão", "quantidade"],
    accepts: ["XLSX", "XLS", "CSV", "PDF", "DOCX", "JPG", "PNG", "WEBP"],
  },
  {
    id: "costs",
    label: "Custos e orçamento",
    shortLabel: "Custos",
    description:
      "Custos realizados e orçados por fazenda, cultura, talhão e centro de custo.",
    requiredColumns: ["data", "empresa", "centro de custo", "conta", "valor"],
    accepts: ["XLSX", "XLS", "CSV", "PDF", "DOCX"],
  },
  {
    id: "accounting",
    label: "Contábil",
    shortLabel: "Contábil",
    description:
      "Balancete, razão, DRE, plano de contas, rateios e conciliações.",
    requiredColumns: ["data", "conta", "histórico", "débito", "crédito", "saldo"],
    accepts: ["XLSX", "XLS", "CSV", "PDF", "DOCX"],
  },
  {
    id: "cashflow",
    label: "Financeiro e dívida",
    shortLabel: "Financeiro",
    description:
      "Fluxo de caixa, contas a pagar/receber, extratos, financiamentos, CPRs e câmbio.",
    requiredColumns: ["data", "vencimento", "valor", "natureza", "moeda"],
    accepts: ["XLSX", "XLS", "CSV", "PDF", "DOCX", "JPG", "PNG", "WEBP"],
  },
  {
    id: "commercial",
    label: "Comercial e mercado",
    shortLabel: "Comercial",
    description:
      "Vendas, contratos, preços, volumes, estoque comprometido, câmbio e travas.",
    requiredColumns: ["data", "produto", "quantidade", "preço", "cliente"],
    accepts: ["XLSX", "XLS", "CSV", "PDF", "DOCX"],
  },
  {
    id: "inventory",
    label: "Estoque e patrimônio",
    shortLabel: "Estoque",
    description:
      "SB2, inventário físico, ativos, imóveis, lavouras em formação e investimentos.",
    requiredColumns: ["data", "item", "quantidade", "valor", "local"],
    accepts: ["XLSX", "XLS", "CSV", "PDF", "DOCX"],
  },
  {
    id: "governance",
    label: "Documentos de gestão",
    shortLabel: "Gestão",
    description:
      "Políticas, contratos, riscos, metas, orçamento, relatórios e documentos estratégicos.",
    requiredColumns: [],
    accepts: ["PDF", "DOCX", "TXT", "JPG", "PNG", "WEBP"],
  },
] as const;

export type DataCategoryId = (typeof DATA_CATEGORIES)[number]["id"];

export type SourceStatus = "processing" | "ready" | "needs-review" | "failed";

export interface EvidenceFragment {
  reference: string;
  text: string;
}

export interface ExtractedSource {
  id: string;
  category: DataCategoryId;
  requirementId: string | null;
  fileName: string;
  storagePath?: string;
  mimeType: string;
  size: number;
  status: SourceStatus;
  extractionMethod: "structured" | "text" | "ocr" | "manual-review";
  recordCount: number;
  columns: string[];
  previewRows: Array<Record<string, string | number | null>>;
  evidence: EvidenceFragment[];
  warnings: string[];
  importedAt: string;
}

export const SCENARIO_KEYS = ["pessimistic", "normal", "optimistic"] as const;
export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

export const SCENARIO_LABELS: Record<ScenarioKey, string> = {
  pessimistic: "Pessimista",
  normal: "Normal",
  optimistic: "Otimista",
};

export interface FinancialBase {
  openingCash: number | null;
  cashReceipts: number | null;
  revenue: number | null;
  operatingCosts: number | null;
  financialExpenses: number | null;
  debtServiceDomestic: number | null;
  debtServiceForeign: number | null;
  capex: number | null;
}

export type DriverId =
  | "commodityPrice"
  | "productivity"
  | "operatingCosts"
  | "interestRate"
  | "exchangeRate";

export interface DriverAssumption {
  values: Record<ScenarioKey, number | null>;
  sourceId: string | null;
  reference: string;
}

export type ScenarioAssumptions = Record<DriverId, DriverAssumption>;

export interface SimulationInput {
  base: FinancialBase;
  baseSourceId: string | null;
  baseReference: string;
  assumptions: ScenarioAssumptions;
}

export interface ScenarioResult {
  key: ScenarioKey;
  isCalculable: boolean;
  revenue: number | null;
  cashReceipts: number | null;
  operatingCosts: number | null;
  financialExpenses: number | null;
  debtService: number | null;
  capex: number | null;
  cashAtEnd: number | null;
  operatingMargin: number | null;
  estimatedResult: number | null;
  notes: string[];
}

export interface AnalysisFinding {
  title: string;
  classification: "fato" | "inferência" | "recomendação" | "lacuna";
  explanation: string;
  evidence: string[];
  confidence: number;
}

export interface AiAnalysisResult {
  executiveSummary: string;
  findings: AnalysisFinding[];
  dataGaps: string[];
  consistencyChecks: string[];
  decisionQuestions: string[];
}
