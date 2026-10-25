-- Polaris: начальная схема (v1).
-- Доступ к данным идёт только с сервера (прямое подключение Postgres / service key).
-- RLS включён на всех таблицах без политик: ключ anon не видит ничего.

-- ── Чат ─────────────────────────────────────────────────────────────────────
create table if not exists conversations (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'Новый чат',
  kind        text not null default 'chat' check (kind in ('chat', 'task', 'summary')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists conversations_kind_updated on conversations (kind, updated_at desc);

create table if not exists messages (
  id               uuid primary key default gen_random_uuid(),
  seq              integer generated always as identity,
  conversation_id  uuid not null references conversations (id) on delete cascade,
  role             text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content          text not null default '',
  tool_calls       jsonb,
  tool_call_id     text,
  tool_name        text,
  status           text not null default 'ok' check (status in ('ok', 'error', 'pending', 'rejected')),
  approval_id      uuid,
  provider         text,
  model            text,
  created_at       timestamptz not null default now()
);
create index if not exists messages_conversation_seq on messages (conversation_id, seq);

-- ── Фоновые задачи ──────────────────────────────────────────────────────────
create table if not exists tasks (
  id               uuid primary key default gen_random_uuid(),
  goal             text not null,
  status           text not null default 'scheduled'
                   check (status in ('scheduled', 'in_progress', 'awaiting_approval', 'done', 'failed', 'cancelled')),
  schedule         jsonb,                 -- {type:'once',at} | {type:'interval',everyMinutes} | {type:'daily',time,timezone}
  next_run_at      timestamptz,
  budget           jsonb,                 -- {maxTokens?, maxUsd?}
  run_count        integer not null default 0,
  run_open         boolean not null default false,
  conversation_id  uuid references conversations (id) on delete set null,
  last_result      text,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists tasks_due on tasks (status, next_run_at);

create table if not exists task_steps (
  id          uuid primary key default gen_random_uuid(),
  seq         integer generated always as identity,
  task_id     uuid not null references tasks (id) on delete cascade,
  run_no      integer not null default 1,
  type        text not null,              -- model | tool | approval | result | error | info
  input       jsonb,
  output      jsonb,
  status      text not null default 'ok',
  created_at  timestamptz not null default now()
);
create index if not exists task_steps_task on task_steps (task_id, seq);

-- ── Память ──────────────────────────────────────────────────────────────────
create table if not exists memory (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('fact', 'preference')),
  content     text not null,
  source      text not null default 'user',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists memory_updated on memory (updated_at desc);

-- ── Журнал действий и подтверждения ─────────────────────────────────────────
create table if not exists approvals (
  id               uuid primary key default gen_random_uuid(),
  action           text not null,         -- имя инструмента
  summary          text not null default '',
  payload          jsonb not null default '{}'::jsonb,   -- {args, toolCallId}
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  task_id          uuid references tasks (id) on delete set null,
  conversation_id  uuid references conversations (id) on delete set null,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);
create index if not exists approvals_status on approvals (status, created_at desc);

create table if not exists actions_log (
  id               uuid primary key default gen_random_uuid(),
  tool             text not null,
  args             jsonb not null default '{}'::jsonb,   -- без секретов
  result_summary   text not null default '',
  status           text not null check (status in ('ok', 'error', 'rejected')),
  undo             jsonb,                                 -- {kind, data}, если откат возможен
  undone_at        timestamptz,
  task_id          uuid references tasks (id) on delete set null,
  conversation_id  uuid references conversations (id) on delete set null,
  approval_id      uuid references approvals (id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists actions_log_created on actions_log (created_at desc);

-- ── Заметки, напоминания, уведомления ───────────────────────────────────────
create table if not exists notes (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists reminders (
  id          uuid primary key default gen_random_uuid(),
  text        text not null,
  due_at      timestamptz not null,
  status      text not null default 'pending' check (status in ('pending', 'fired', 'cancelled')),
  created_at  timestamptz not null default now(),
  fired_at    timestamptz
);
create index if not exists reminders_due on reminders (status, due_at);

create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,              -- reminder | task_done | task_failed | approval | morning
  title       text not null,
  body        text not null default '',
  ref         jsonb,                      -- {conversationId?, taskId?, approvalId?}
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_created on notifications (created_at desc);

-- ── Бюджет ──────────────────────────────────────────────────────────────────
create table if not exists usage_log (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null,
  model              text not null default '',
  prompt_tokens      integer not null default 0,
  completion_tokens  integer not null default 0,
  cost_usd           double precision not null default 0,
  task_id            uuid references tasks (id) on delete set null,
  conversation_id    uuid references conversations (id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists usage_log_created on usage_log (created_at desc);
create index if not exists usage_log_conversation on usage_log (conversation_id, created_at);

-- ── Провайдеры, настройки, сессии ───────────────────────────────────────────
create table if not exists provider_credentials (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null unique,
  encrypted_token  text not null,         -- AES-256-GCM: iv.tag.ciphertext (base64url)
  account_id       text,
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists oauth_flows (
  state          text primary key,
  provider       text not null,
  code_verifier  text not null,
  created_at     timestamptz not null default now()
);

create table if not exists settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists sessions (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);

-- ── RLS: всё закрыто для публичных ключей ───────────────────────────────────
alter table conversations         enable row level security;
alter table messages              enable row level security;
alter table tasks                 enable row level security;
alter table task_steps            enable row level security;
alter table memory                enable row level security;
alter table approvals             enable row level security;
alter table actions_log           enable row level security;
alter table notes                 enable row level security;
alter table reminders             enable row level security;
alter table notifications         enable row level security;
alter table usage_log             enable row level security;
alter table provider_credentials  enable row level security;
alter table oauth_flows           enable row level security;
alter table settings              enable row level security;
alter table sessions              enable row level security;
