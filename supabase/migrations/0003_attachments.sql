-- Вложения к сообщениям чата (изображения). Данные хранятся в базе в base64: так они переживают
-- перезапуск сервера даже там, где файловая система временная (Render free).
create table if not exists attachments (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid references messages (id) on delete cascade,  -- null, пока сообщение не отправлено
  name        text not null,
  mime        text not null,
  data_b64    text not null,
  created_at  timestamptz not null default now()
);
create index if not exists attachments_message on attachments (message_id);

alter table attachments enable row level security;
