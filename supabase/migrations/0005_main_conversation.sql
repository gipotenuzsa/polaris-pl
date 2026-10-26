-- Единый сквозной разговор: помечается is_main (он один). Для длинных разговоров хранится сводка старой части:
-- summary — текст сводки, summary_upto — seq последнего сообщения, вошедшего в сводку.
alter table conversations add column if not exists is_main boolean not null default false;
create unique index if not exists conversations_one_main on conversations (is_main) where is_main;
alter table conversations add column if not exists summary text not null default '';
alter table conversations add column if not exists summary_upto integer not null default 0;
