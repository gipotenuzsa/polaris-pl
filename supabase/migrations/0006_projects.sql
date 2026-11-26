-- Проекты: папки для чатов с общими инструкциями (как в ChatGPT).
create table if not exists projects (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  instructions  text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table projects enable row level security;

-- При удалении проекта чаты остаются, просто выходят из него.
alter table conversations add column if not exists project_id uuid references projects (id) on delete set null;
create index if not exists conversations_project on conversations (project_id);
