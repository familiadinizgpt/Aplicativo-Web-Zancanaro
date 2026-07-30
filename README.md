# Vértice — Inteligência Agrícola

Webapp para conduzir análises agrícolas, financeiras, contábeis e estratégicas sem preencher lacunas com dados fictícios.

## O que a aplicação entrega

- Acesso por link mágico e espaço privado por usuário;
- Upload múltiplo, simultâneo e segregado por estrutura, operação, custos, contabilidade, financeiro, comercial, estoque/patrimônio e gestão;
- Extração de XLSX/XLS/CSV, PDF com camada de texto, DOCX e OCR de imagens (PNG/JPG/WebP);
- Prévia de registros, colunas, trechos e avisos de qualidade;
- Cruzamentos reais entre duas planilhas/CSVs privados, com chaves identificadas, contagem de correspondências e amostras não conciliadas;
- Simulador de fluxo com três cenários: pessimista, normal e otimista;
- Osciladores documentados: preço de commodities, produtividade/clima, custos operacionais, juros e câmbio;
- Bloqueio de cálculo e exportação enquanto não houver valores-base, fonte e referência para cada premissa;
- Leitura assistida por IA com saída estruturada em fatos, inferências, recomendações e lacunas;
- Exportação de análise comparativa em `.docx`.

Não existem números, arquivos ou resultados de demonstração. A tela inicia vazia e cada fonte usada na exportação é buscada novamente no Supabase pelo servidor.

## Guardrails metodológicos

O modelo foi implementado a partir das diretrizes do material fornecido:

- A sequência analítica é operacional → tática → estratégica → conselho;
- A fonte é obrigatória para qualquer número ou conclusão;
- Custos, despesas, CAPEX e estoques não devem ser misturados;
- Café e algodão têm regras produtivas próprias a serem aplicadas em mapeamentos específicos;
- A receita gerencial deve considerar faturamento e estoque final valorizado quando essa for a regra documentada;
- Lucro por hectare é indicador central quando área, custo e produção estiverem reconciliados;
- Cenários são sensibilidades, não previsões. Sem calendário de recebimentos, o fluxo é sinalizado como estimativa direcional;
- PDF escaneado sem camada de texto precisa ser enviado como imagem para OCR nesta versão, ou processado por um serviço de OCR de PDF configurado futuramente.

## Executar localmente

```bash
npm install
cp .env.example .env.local
npm run dev
```

O modo local permite explorar a interface e a extração. Para habilitar a análise IA, defina `AI_GATEWAY_API_KEY` somente no servidor.

## Supabase: implantação segura

O banco dedicado em uso é **Webapp Zancanaro**. O projeto existente `consultor-agro-hub` não deve receber estes documentos, pois já possui restrição explícita contra armazenamento de dados fiscais, contábeis e documentos de clientes.

1. No SQL Editor, aplique [`supabase/schema.sql`](supabase/schema.sql) caso o esquema ainda não esteja presente;
2. Em **Authentication → URL Configuration**, inclua o endereço publicado seguido de `/auth/callback` na lista de Redirect URLs. Inclua `http://localhost:3000/auth/callback` para desenvolvimento local;
3. Em **Integrations → Data API**, confirme que as tabelas `public` necessárias estão expostas;
4. Configure:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
AI_GATEWAY_API_KEY=...
```

O esquema utiliza RLS em todas as tabelas e bucket privado. Cada arquivo é armazenado sob o prefixo do próprio `auth.uid()` e tem limite de 25 MB.

## Vercel

Configure `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` no projeto Vercel. O `AI_GATEWAY_API_KEY`, quando usado, não recebe prefixo `NEXT_PUBLIC_` e nunca deve ir para o navegador. Em uma implantação com Vercel AI Gateway/OIDC habilitado, a rota de IA também pode usar a credencial de curta duração fornecida pela Vercel.

O OCR executa em Node.js para imagens. PDFs escaneados sem camada de texto são mantidos como revisão manual — envie as páginas relevantes em PNG/JPG/WebP ou conecte um serviço específico de OCR de PDF antes de usá-los em cálculos.

## Repositório

O repositório de código é `familiadinizgpt/Aplicativo-Web-Zancanaro`.

## Estrutura

```text
src/app/api/extract      Extração e OCR
src/app/api/analyze      IA estruturada e baseada em evidências
src/app/api/export       Geração de relatório .docx
src/lib/analysis         Motor de cenários e regras de validação
src/lib/supabase         Clientes de browser e servidor
supabase/schema.sql      Esquema seguro do projeto dedicado
```

## Antes de usar para decisão

1. Revise todo OCR; especialmente sinal, data, vírgula, unidade e nomes de contas.
2. Escolha a fonte e a referência de cada oscilador.
3. Concilie estoques, custos, contabilidade e fluxo antes de tratar a simulação como base de decisão.
4. Valide com controladoria, financeiro e gestão agrícola as premissas que alterem preço, volume, câmbio, juros ou CAPEX.
