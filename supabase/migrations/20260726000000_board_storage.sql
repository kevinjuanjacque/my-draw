-- Persistent Excalidraw boards. Apply with `supabase db push`.
create extension if not exists pgcrypto with schema extensions;

create table public.boards (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.board_snapshots (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards (id) on delete cascade,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index board_snapshots_latest_by_board
  on public.board_snapshots (board_id, created_at desc);

create table public.board_read_shares (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index board_read_shares_one_active_per_board
  on public.board_read_shares (board_id)
  where revoked_at is null;

create or replace function public.touch_board_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'boards' then
    new.updated_at := now();
    return new;
  end if;

  update public.boards
  set updated_at = now()
  where id = new.board_id;
  return new;
end;
$$;

create trigger boards_set_updated_at
  before update on public.boards
  for each row
  execute function public.touch_board_updated_at();

create trigger snapshots_touch_board
  after insert on public.board_snapshots
  for each row
  execute function public.touch_board_updated_at();

revoke all on function public.touch_board_updated_at() from public;

alter table public.boards enable row level security;
alter table public.board_snapshots enable row level security;
alter table public.board_read_shares enable row level security;

create policy "owners manage their boards"
  on public.boards
  for all
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "owners read board snapshots"
  on public.board_snapshots
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.boards
      where boards.id = board_snapshots.board_id
        and boards.owner_id = (select auth.uid())
    )
  );

create policy "owners add board snapshots"
  on public.board_snapshots
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.boards
      where boards.id = board_snapshots.board_id
        and boards.owner_id = (select auth.uid())
    )
  );

-- Read-share rows are intentionally inaccessible through PostgREST. Only the
-- RPCs below may create, revoke, or resolve a token.
create or replace function public.create_board_read_share(target_board_id uuid)
returns table (token text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  generated_token text;
begin
  if auth.uid() is null or not exists (
    select 1 from public.boards
    where id = target_board_id and owner_id = auth.uid()
  ) then
    raise exception 'board not found' using errcode = 'P0002';
  end if;

  update public.board_read_shares
  set revoked_at = now()
  where board_id = target_board_id and revoked_at is null;

  generated_token := encode(gen_random_bytes(32), 'hex');
  insert into public.board_read_shares (board_id, token_hash)
  values (target_board_id, encode(digest(generated_token, 'sha256'), 'hex'));

  return query select generated_token;
end;
$$;

create or replace function public.revoke_board_read_share(target_board_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.boards
    where id = target_board_id and owner_id = auth.uid()
  ) then
    raise exception 'board not found' using errcode = 'P0002';
  end if;

  update public.board_read_shares
  set revoked_at = now()
  where board_id = target_board_id and revoked_at is null;
end;
$$;

create or replace function public.get_shared_board_snapshot(read_token text)
returns table (
  board_id uuid,
  title text,
  snapshot jsonb,
  snapshot_created_at timestamptz
)
language sql
security definer
set search_path = public, extensions
as $$
  select boards.id, boards.title, snapshots.snapshot, snapshots.created_at
  from public.board_read_shares shares
  join public.boards on boards.id = shares.board_id
  join lateral (
    select board_snapshots.snapshot, board_snapshots.created_at
    from public.board_snapshots
    where board_snapshots.board_id = boards.id
    order by board_snapshots.created_at desc
    limit 1
  ) snapshots on true
  where shares.revoked_at is null
    and shares.token_hash = encode(digest(read_token, 'sha256'), 'hex');
$$;

revoke all on function public.create_board_read_share(uuid) from public;
revoke all on function public.revoke_board_read_share(uuid) from public;
revoke all on function public.get_shared_board_snapshot(text) from public;
grant execute on function public.create_board_read_share(uuid) to authenticated;
grant execute on function public.revoke_board_read_share(uuid) to authenticated;
grant execute on function public.get_shared_board_snapshot(text) to anon, authenticated;
