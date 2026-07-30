import {
  type DriverId,
  type FinancialBase,
  type ScenarioAssumptions,
  type ScenarioKey,
  type ScenarioResult,
  type SimulationInput,
} from "@/lib/types";

export const DRIVER_DEFINITIONS: Array<{
  id: DriverId;
  label: string;
  description: string;
  appliesTo: string;
}> = [
  {
    id: "commodityPrice",
    label: "Preço de commodities",
    description: "Variação do preço médio realizado ou contratado no período.",
    appliesTo: "Receita e recebimentos",
  },
  {
    id: "productivity",
    label: "Produtividade / clima",
    description: "Variação no volume comercializável decorrente de produtividade, perdas ou clima.",
    appliesTo: "Receita e recebimentos",
  },
  {
    id: "operatingCosts",
    label: "Custos operacionais",
    description: "Variação de insumos, energia, manutenção, serviços e demais custos da safra.",
    appliesTo: "Custos operacionais",
  },
  {
    id: "interestRate",
    label: "Juros",
    description: "Variação incidente sobre a despesa financeira prevista.",
    appliesTo: "Despesa financeira",
  },
  {
    id: "exchangeRate",
    label: "Câmbio",
    description: "Variação sobre o serviço de dívida já identificado em moeda estrangeira.",
    appliesTo: "Serviço de dívida em moeda estrangeira",
  },
];

export const EMPTY_FINANCIAL_BASE: FinancialBase = {
  openingCash: null,
  cashReceipts: null,
  revenue: null,
  operatingCosts: null,
  financialExpenses: null,
  debtServiceDomestic: null,
  debtServiceForeign: null,
  capex: null,
};

function emptyDriver() {
  return {
    values: { pessimistic: 0, normal: 0, optimistic: 0 },
    sourceId: null,
    reference: "",
  };
}

export function createEmptyAssumptions(): ScenarioAssumptions {
  return {
    commodityPrice: emptyDriver(),
    productivity: emptyDriver(),
    operatingCosts: emptyDriver(),
    interestRate: emptyDriver(),
    exchangeRate: emptyDriver(),
  };
}

export function createEmptySimulationInput(): SimulationInput {
  return {
    base: EMPTY_FINANCIAL_BASE,
    baseSourceId: null,
    baseReference: "",
    assumptions: createEmptyAssumptions(),
  };
}

const requiredBaseFields: Array<keyof FinancialBase> = [
  "openingCash",
  "cashReceipts",
  "revenue",
  "operatingCosts",
  "financialExpenses",
  "debtServiceDomestic",
  "debtServiceForeign",
  "capex",
];

export function getMissingSimulationRequirements(input: SimulationInput): string[] {
  const missing = requiredBaseFields
    .filter((field) => input.base[field] === null)
    .map((field) => `Valor-base ausente: ${formatFieldName(field)}.`);

  if (!input.baseSourceId) {
    missing.push("Selecione o documento que fundamenta os valores-base.");
  }
  if (!input.baseReference.trim()) {
    missing.push("Informe a referência exata dos valores-base (aba, página ou seção).");
  }

  for (const driver of DRIVER_DEFINITIONS) {
    const current = input.assumptions[driver.id];
    if (!current.sourceId) {
      missing.push(`Selecione a fonte da premissa: ${driver.label}.`);
    }
    if (!current.reference.trim()) {
      missing.push(`Informe a referência (aba, página ou seção) de: ${driver.label}.`);
    }
    for (const scenario of ["pessimistic", "normal", "optimistic"] as const) {
      if (current.values[scenario] === null) {
        missing.push(`${driver.label}: falta a variação do cenário ${scenario}.`);
      }
    }
  }
  return missing;
}

export function calculateScenario(input: SimulationInput, key: ScenarioKey): ScenarioResult {
  const missing = getMissingSimulationRequirements(input);
  if (missing.length > 0) {
    return {
      key,
      isCalculable: false,
      revenue: null,
      cashReceipts: null,
      operatingCosts: null,
      financialExpenses: null,
      debtService: null,
      capex: null,
      cashAtEnd: null,
      operatingMargin: null,
      estimatedResult: null,
      notes: missing,
    };
  }

  const b = input.base;
  const value = (driver: DriverId) => input.assumptions[driver].values[key] ?? 0;
  const priceFactor = 1 + value("commodityPrice") / 100;
  const productivityFactor = 1 + value("productivity") / 100;
  const revenueFactor = priceFactor * productivityFactor;
  const costFactor = 1 + value("operatingCosts") / 100;
  const interestFactor = 1 + value("interestRate") / 100;
  const exchangeFactor = 1 + value("exchangeRate") / 100;

  const revenue = (b.revenue ?? 0) * revenueFactor;
  const cashReceipts = (b.cashReceipts ?? 0) * revenueFactor;
  const operatingCosts = (b.operatingCosts ?? 0) * costFactor;
  const financialExpenses = (b.financialExpenses ?? 0) * interestFactor;
  const debtService =
    (b.debtServiceDomestic ?? 0) + (b.debtServiceForeign ?? 0) * exchangeFactor;
  const capex = b.capex ?? 0;
  const cashAtEnd = (b.openingCash ?? 0) + cashReceipts - operatingCosts - debtService - capex;
  const operatingMargin = revenue === 0 ? null : (revenue - operatingCosts) / revenue;
  const estimatedResult = revenue - operatingCosts - financialExpenses;

  return {
    key,
    isCalculable: true,
    revenue,
    cashReceipts,
    operatingCosts,
    financialExpenses,
    debtService,
    capex,
    cashAtEnd,
    operatingMargin,
    estimatedResult,
    notes: [
      "Recebimentos acompanham a variação combinada de preço e produtividade; o calendário de recebimento continua sendo uma validação obrigatória.",
      "Câmbio incide somente sobre o serviço de dívida em moeda estrangeira informado; não reavalia o saldo total da dívida.",
      "O resultado estimado é gerencial e não substitui DRE, DFC ou revisão contábil oficial.",
    ],
  };
}

export function calculateAllScenarios(input: SimulationInput) {
  return {
    pessimistic: calculateScenario(input, "pessimistic"),
    normal: calculateScenario(input, "normal"),
    optimistic: calculateScenario(input, "optimistic"),
  };
}

function formatFieldName(field: keyof FinancialBase) {
  const labels: Record<keyof FinancialBase, string> = {
    openingCash: "Caixa inicial",
    cashReceipts: "Recebimentos previstos",
    revenue: "Receita prevista",
    operatingCosts: "Custos operacionais",
    financialExpenses: "Despesas financeiras",
    debtServiceDomestic: "Serviço de dívida nacional",
    debtServiceForeign: "Serviço de dívida em moeda estrangeira",
    capex: "Investimentos / CAPEX",
  };
  return labels[field];
}
