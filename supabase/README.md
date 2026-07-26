# Supabase board storage

Apply migrations with the Supabase CLI:

```sh
supabase link --project-ref <project-ref>
supabase db push
```

Configure only these public browser values in the app environment:

```dotenv
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
```

Enable Email authentication in Supabase. The browser client uses email/password through `signInWithPassword` and `signUp`; service-role keys must never be put in `VITE_*` variables.

`boards` and `board_snapshots` are owner-only under RLS. Read links are opaque, random tokens resolved exclusively by `get_shared_board_snapshot`. A link is valid for 30 days; creating a replacement revokes the prior link for that board. The RPC returns one board's latest snapshot and does not expose board lists or share-token hashes.
