-- Web Push: подписки устройств (PWA на iPhone/Android, браузеры).
create table if not exists push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  failures     integer not null default 0,
  created_at   timestamptz not null default now(),
  last_ok_at   timestamptz
);

alter table push_subscriptions enable row level security;
