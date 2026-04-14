export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const hours = Math.min(Math.max(parseInt(url.searchParams.get("hours") || "24", 10), 1), 168);
  const status = url.searchParams.get("status") || "success"; // success | error | "" (todos)
  const scriptName = env.CF_SCRIPT_NAME || "crr-api";

  // valida envs
  const need = ["UPSTASH_EMAIL","UPSTASH_API_KEY","UPSTASH_DB_ID","CF_ACCOUNT_TAG","CF_API_TOKEN"];
  for (const k of need) {
    if (!env[k]) return json({ ok:false, error:`Falta variável ${k}` }, 500);
  }

  // Upstash stats (Developer API)
  const upAuth = "Basic " + btoa(`${env.UPSTASH_EMAIL}:${env.UPSTASH_API_KEY}`);
  const upRes = await fetch(`https://api.upstash.com/v2/redis/stats/${encodeURIComponent(env.UPSTASH_DB_ID)}`, {
    headers: { Authorization: upAuth, Accept: "application/json" },
  });
  const upData = await upRes.json().catch(() => null);

  // Cloudflare Worker analytics (GraphQL)
  const end = new Date();
  const start = new Date(Date.now() - hours * 60 * 60 * 1000);

  const query = `
    query GetWorkersAnalytics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string, $status: string) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          workersInvocationsAdaptive(limit: 100, filter: {
            scriptName: $scriptName,
            datetime_geq: $datetimeStart,
            datetime_leq: $datetimeEnd,
            status: $status
          }) {
            sum { subrequests requests errors }
            quantiles { cpuTimeP50 cpuTimeP90 cpuTimeP99 }
          }
        }
      }
    }
  `;
  const variables = {
    accountTag: env.CF_ACCOUNT_TAG,
    datetimeStart: start.toISOString(),
    datetimeEnd: end.toISOString(),
    scriptName,
    status: status ? status : null
  };

  const cfRes = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method:"POST",
    headers:{
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type":"application/json",
      Accept:"application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  const cfJson = await cfRes.json().catch(()=>null);

  const node = cfJson?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0];
  const sum = node?.sum || {};
  const q = node?.quantiles || {};

  return json({
    ok: true,
    at: new Date().toISOString(),
    period: { hours, status, scriptName },
    upstash: {
      ok: upRes.ok,
      total_monthly_requests: upData?.total_monthly_requests ?? upData?.total_monthly_net_commands ?? upData?.total_monthly_commands ?? null,
      monthly_reads: upData?.total_monthly_read_requests ?? null,
      monthly_writes: upData?.total_monthly_write_requests ?? null,
      daily_net_commands: upData?.daily_net_commands ?? upData?.daily_commands ?? null,
      current_storage_bytes: upData?.current_storage ?? null,
      monthly_billing_usd: upData?.total_monthly_billing ?? null
    },
    cloudflare: {
      ok: cfRes.ok && !cfJson?.errors,
      requests: sum.requests ?? 0,
      subrequests: sum.subrequests ?? 0,
      errors: sum.errors ?? 0,
      cpu_p50_us: q.cpuTimeP50 ?? null,
      cpu_p90_us: q.cpuTimeP90 ?? null,
      cpu_p99_us: q.cpuTimeP99 ?? null
    }
  });
}

function json(obj, status=200){
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"max-age=15" }
  });
}
