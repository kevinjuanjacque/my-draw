-- Board read links expire so an old opaque token cannot grant indefinite access.
alter table public.board_read_shares
  add column expires_at timestamptz;

update public.board_read_shares
set expires_at = created_at + interval '30 days'
where expires_at is null;

alter table public.board_read_shares
  alter column expires_at set not null;

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
  insert into public.board_read_shares (board_id, token_hash, expires_at)
  values (
    target_board_id,
    encode(digest(generated_token, 'sha256'), 'hex'),
    now() + interval '30 days'
  );

  return query select generated_token;
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
    and shares.expires_at > now()
    and shares.token_hash = encode(digest(read_token, 'sha256'), 'hex');
$$;
