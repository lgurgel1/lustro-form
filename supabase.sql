-- ============================================================
-- Formulário Lustro — estrutura do banco (rodar no SQL Editor do Supabase)
-- ============================================================

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- respostas do formulário
  nome text,
  whatsapp text,
  instagram text,
  comprometido text,
  carros_mes text,
  vende_vitrificacao_ppf text,
  investiu_trafego_ia text,
  faturamento text,
  qualificado boolean default false,

  -- rastreio de campanha / Meta
  fbp text,
  fbc text,
  event_id text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  user_agent text,
  ip text,

  -- backup bruto de todas as respostas
  raw jsonb
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_qualificado_idx on public.leads (qualificado);

-- Segurança: a tabela fica FECHADA. A função serverless grava usando a
-- service_role key (que ignora o RLS). Assim ninguém consegue ler/gravar
-- direto pelo navegador. Não crie policy pública.
alter table public.leads enable row level security;
