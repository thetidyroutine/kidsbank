// Sends queued KidsBank messages through WAHA, trying the backup instance if the first one fails.
// Takes no input from the caller: it only drains the queue in public.notifications.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const instances = [
  {
    name: "jobkiller",
    url: "https://waha.jobkiller.net",
    session: "n8n_jobkiller",
    key: Deno.env.get("WAHA_PRIMARY_KEY"),
  },
  {
    name: "pacahome",
    url: "https://waha.pacahome.net",
    session: Deno.env.get("WAHA_BACKUP_SESSION"),
    key: Deno.env.get("WAHA_BACKUP_KEY"),
  },
].filter((i) => i.key && i.session);

async function send(instance: typeof instances[number], phone: string, text: string) {
  const res = await fetch(instance.url + "/api/sendText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": instance.key! },
    body: JSON.stringify({
      session: instance.session,
      chatId: phone.replace(/^\+/, "") + "@c.us",
      text,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
}

Deno.serve(async () => {
  const { data: due, error } = await db.rpc("claim_notifications");
  if (error) return Response.json({ error: "claim failed" }, { status: 500 });

  let sent = 0;
  let failed = 0;
  for (const n of due ?? []) {
    const errors: string[] = [];
    let via: string | null = null;
    for (const instance of instances) {
      try {
        await send(instance, n.phone, n.body);
        via = instance.name;
        break;
      } catch (e) {
        errors.push(instance.name + ": " + (e instanceof Error ? e.message : "error"));
      }
    }
    if (via) sent++;
    else failed++;
    await db.rpc("finish_notification", {
      nid: n.id,
      ok: via !== null,
      via,
      error: errors.join("; ") || (instances.length ? null : "no WAHA instance configured"),
    });
  }
  return Response.json({ sent, failed });
});
