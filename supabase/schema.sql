-- Таблица для синхронизации календаря между телефоном и ноутбуком.
-- Запустить один раз в Supabase: SQL Editor -> New query -> вставить -> Run.

create table if not exists public.items (
  user_id    uuid    not null default auth.uid() references auth.users on delete cascade,
  id         text    not null,
  coll       text    not null,
  data       jsonb,
  deleted    boolean not null default false,
  updated_at bigint  not null,              -- время правки на устройстве (мс)
  server_at  timestamptz not null default clock_timestamp(),  -- время записи на сервере
  primary key (user_id, id)
);

create index if not exists items_user_server_at on public.items (user_id, server_at);

-- server_at всегда ставит сервер, чтобы часы устройств не мешали синхронизации
create or replace function public.items_touch() returns trigger
language plpgsql as $$
begin
  new.server_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists items_touch on public.items;
create trigger items_touch before insert or update on public.items
  for each row execute function public.items_touch();

-- Доступ только к своим записям
alter table public.items enable row level security;

drop policy if exists "own rows" on public.items;
create policy "own rows" on public.items
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.items to authenticated;
revoke all on public.items from anon;

-- Мгновенные обновления на другом устройстве
do $$
begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null;
end $$;
