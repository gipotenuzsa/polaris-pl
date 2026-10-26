-- Закреплённые чаты: поднимаются в начало списка.
alter table conversations add column if not exists pinned boolean not null default false;
