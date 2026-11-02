-- Tells the child and the other parents or admins about every decision, with an optional note.

alter table public.requests
  add column decision_note text check (char_length(decision_note) <= 200);

drop function public.decide_request(bigint, boolean);

create function public.decide_request(request_id bigint, approve boolean, note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  tx_id bigint;
begin
  select * into r from public.requests where id = request_id for update;
  if r.id is null then raise exception 'Anfrage nicht gefunden'; end if;
  if not private.is_guardian(r.child_id) then raise exception 'Keine Berechtigung'; end if;
  if r.status <> 'pending' then raise exception 'Anfrage wurde bereits entschieden'; end if;

  if approve then
    insert into public.transactions (child_id, type, description, amount, created_by)
    values (r.child_id, r.kind, r.description,
            case r.kind when 'withdrawal' then -r.amount else r.amount end, auth.uid())
    returning id into tx_id;
  end if;

  update public.requests
     set status = case when approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), transaction_id = tx_id,
         decision_note = nullif(trim(note), '')
   where id = request_id;
end $$;

revoke all on function public.decide_request(bigint, boolean, text) from public, anon;
grant execute on function public.decide_request(bigint, boolean, text) to authenticated;

create or replace function private.notify_decision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  child_name text;
  child_phone text;
  decider text;
  verb text := case new.status when 'approved' then 'genehmigt' else 'abgelehnt' end;
  note_line text := coalesce(E'\nNachricht: ' || new.decision_note, '');
begin
  if old.status <> 'pending' or new.status = 'pending' then return null; end if;
  select c.name, p.phone into child_name, child_phone
  from public.children c left join public.profiles p on p.child_id = c.id
  where c.id = new.child_id;
  select initcap(username) into decider from public.profiles where user_id = new.decided_by;

  if child_phone is not null then
    insert into public.notifications (phone, body) values (child_phone,
      'KidsBank: Deine Anfrage über ' || private.money(new.amount) || ' (' || new.description || ') wurde ' || verb || '.' || note_line);
  end if;

  insert into public.notifications (phone, body)
  select p.phone,
         'KidsBank: ' || coalesce(decider, 'Jemand') || ' hat die Anfrage von ' || child_name || ' über ' ||
         private.money(new.amount) || ' (' || new.description || ') ' || verb || '.' || note_line
  from public.profiles p
  where p.phone is not null
    and p.user_id is distinct from new.decided_by
    and (p.role = 'admin'
         or exists (select 1 from public.parent_children pc where pc.user_id = p.user_id and pc.child_id = new.child_id));

  if new.status = 'approved' and new.kind = 'withdrawal' then
    insert into public.notifications (phone, body)
    select p.phone,
           'KidsBank: Jetzt per TWINT senden: ' || private.money(new.amount) || ' an ' || child_name ||
           coalesce(' (' || child_phone || ')', '') || E'\nGrund: ' || new.description
    from public.profiles p
    where p.user_id = new.decided_by and p.phone is not null;
  end if;
  return null;
end $$;
