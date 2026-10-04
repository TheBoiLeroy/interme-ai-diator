-- Pending email invites for the signed-in person, with the workspace name.
-- Invitees aren't members yet, so RLS hides the workspace row from them.

create or replace function public.my_invitations()
returns table (id uuid, workspace_id uuid, workspace_name text, invited_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, w.id, w.name, i.created_at
  from public.workspace_invites i
  join public.workspaces w on w.id = i.workspace_id
  where i.accepted_at is null
    and lower(i.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  order by i.created_at;
$$;

revoke execute on function public.my_invitations() from public, anon;
grant execute on function public.my_invitations() to authenticated;
