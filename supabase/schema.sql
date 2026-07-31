-- Inteligência Agrícola: esquema de persistência para um projeto Supabase dedicado.
-- Execute somente em um projeto criado para dados corporativos sensíveis.
-- Não aplique este esquema ao projeto "consultor-agro-hub", que foi configurado
-- para não armazenar documentos fiscais, contábeis ou arquivos de clientes.

create extension if not exists pgcrypto;

create table if not exists public.analysis_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  company_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.source_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.analysis_workspaces(id) on delete cascade,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  category text not null check (category in (
    'structure', 'production', 'costs', 'accounting', 'cashflow', 'commercial', 'inventory', 'governance'
  )),
  requirement_id text,
  original_name text not null,
  storage_path text not null unique,
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0 and byte_size <= 26214400),
  extraction_status text not null default 'queued' check (extraction_status in ('queued', 'processing', 'ready', 'needs_review', 'failed')),
  extraction_method text check (extraction_method in ('structured', 'text', 'ocr', 'manual_review')),
  record_count integer not null default 0 check (record_count >= 0),
  columns_json jsonb not null default '[]'::jsonb,
  preview_json jsonb not null default '[]'::jsonb,
  warnings_json jsonb not null default '[]'::jsonb,
  content_sha256 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.evidence_fragments (
  id uuid primary key default gen_random_uuid(),
  source_file_id uuid not null references public.source_files(id) on delete cascade,
  reference text not null,
  content text not null,
  ordinal integer not null default 0 check (ordinal >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.scenario_sets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.analysis_workspaces(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  name text not null default 'Cenário comparativo',
  baseline_source_id uuid references public.source_files(id) on delete set null,
  baseline_reference text,
  baseline_json jsonb not null,
  assumptions_json jsonb not null,
  calculated_results_json jsonb not null,
  is_final boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.analysis_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.analysis_workspaces(id) on delete cascade,
  scenario_set_id uuid references public.scenario_sets(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  analysis_json jsonb not null,
  export_storage_path text,
  created_at timestamptz not null default now()
);

create index if not exists source_files_workspace_idx on public.source_files(workspace_id, created_at desc);
create index if not exists evidence_fragments_source_idx on public.evidence_fragments(source_file_id, ordinal);
create index if not exists scenario_sets_workspace_idx on public.scenario_sets(workspace_id, created_at desc);
create index if not exists analysis_reports_workspace_idx on public.analysis_reports(workspace_id, created_at desc);
create index if not exists analysis_workspaces_owner_idx on public.analysis_workspaces(owner_id);
create index if not exists source_files_uploaded_by_idx on public.source_files(uploaded_by);
create index if not exists scenario_sets_created_by_idx on public.scenario_sets(created_by);
create index if not exists scenario_sets_baseline_source_idx on public.scenario_sets(baseline_source_id);
create index if not exists analysis_reports_created_by_idx on public.analysis_reports(created_by);
create index if not exists analysis_reports_scenario_set_idx on public.analysis_reports(scenario_set_id);

alter table public.analysis_workspaces enable row level security;
alter table public.source_files enable row level security;
alter table public.evidence_fragments enable row level security;
alter table public.scenario_sets enable row level security;
alter table public.analysis_reports enable row level security;

grant select, insert, update, delete on public.analysis_workspaces to authenticated;
grant select, insert, update, delete on public.source_files to authenticated;
grant select, insert, update, delete on public.evidence_fragments to authenticated;
grant select, insert, update, delete on public.scenario_sets to authenticated;
grant select, insert, update, delete on public.analysis_reports to authenticated;

create policy "Users manage own analysis workspaces"
on public.analysis_workspaces for all to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

create policy "Users manage sources in own workspaces"
on public.source_files for all to authenticated
using (
  exists (
    select 1 from public.analysis_workspaces workspace
    where workspace.id = source_files.workspace_id
      and workspace.owner_id = (select auth.uid())
  )
)
with check (
  (select auth.uid()) = uploaded_by
  and exists (
    select 1 from public.analysis_workspaces workspace
    where workspace.id = source_files.workspace_id
      and workspace.owner_id = (select auth.uid())
  )
);

create policy "Users manage evidence in own workspaces"
on public.evidence_fragments for all to authenticated
using (
  exists (
    select 1
    from public.source_files source
    join public.analysis_workspaces workspace on workspace.id = source.workspace_id
    where source.id = evidence_fragments.source_file_id
      and workspace.owner_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.source_files source
    join public.analysis_workspaces workspace on workspace.id = source.workspace_id
    where source.id = evidence_fragments.source_file_id
      and workspace.owner_id = (select auth.uid())
  )
);

create policy "Users manage scenarios in own workspaces"
on public.scenario_sets for all to authenticated
using (
  exists (
    select 1 from public.analysis_workspaces workspace
    where workspace.id = scenario_sets.workspace_id
      and workspace.owner_id = (select auth.uid())
  )
)
with check (
  (select auth.uid()) = created_by
  and exists (
    select 1 from public.analysis_workspaces workspace
    where workspace.id = scenario_sets.workspace_id
      and workspace.owner_id = (select auth.uid())
  )
);

create policy "Users manage reports in own workspaces"
on public.analysis_reports for all to authenticated
using (
  exists (
    select 1 from public.analysis_workspaces workspace
    where workspace.id = analysis_reports.workspace_id
      and workspace.owner_id = (select auth.uid())
  )
)
with check (
  (select auth.uid()) = created_by
  and exists (
    select 1 from public.analysis_workspaces workspace
    where workspace.id = analysis_reports.workspace_id
      and workspace.owner_id = (select auth.uid())
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'agro-analysis-files',
  'agro-analysis-files',
  false,
  26214400,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'text/plain',
    'image/png',
    'image/jpeg',
    'image/webp'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Users upload own analysis files"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'agro-analysis-files'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "Users read own analysis files"
on storage.objects for select to authenticated
using (
  bucket_id = 'agro-analysis-files'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "Users update own analysis files"
on storage.objects for update to authenticated
using (
  bucket_id = 'agro-analysis-files'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'agro-analysis-files'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "Users delete own analysis files"
on storage.objects for delete to authenticated
using (
  bucket_id = 'agro-analysis-files'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
