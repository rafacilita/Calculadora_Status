export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // ---------- helpers ----------
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj, null, 2), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  const required = [
    "UPSTASH_EMAIL",
    "UPSTASH_API_KEY",
    "UPSTASH_DB_ID",
    "CF_ACCOUNT_TAG",
    "CF_API_TOKEN",
    "CF_SCRIPT_NAME",
  ];
  for (const k of required) {
    if (!env[k]) return json({ ok: false, error: `Falta variável ${k}` }, 400);
  }

  function clampInt(n, min, max, fallback) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(v)));
  }

  function monthRange(ym) {
    // ym = "YYYY-MM"
    const m = /^(\d{4})-(\d{2})$/.exec(ym || "");
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]); // 1..12
    if (mo < 1 || mo > 12) return null;
    const start = new Date(Date.UTC(y, mo - 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(y, mo, 1, 0, 0, 0)); // next month start (exclusive)
    return { start, end };
  }

  function dayRange(from, to) {
    // from/to = "YYYY-MM-DD"
    const f = /^\d{4}-\d{2}-\d{2}$/.test(from || "") ? from : null;
    const t = /^\d{4}-\d{2}-\d{2}$/.test(to || "") ? to : null;
    if (!f || !t) return null;
    const start = new Date(`${f}T00:00:00.000Z`);
    const end = new Date(`${t}T23:59:59.999Z`);
    if (isNaN(start) || isNaN(end)) return null;
    // endExclusive para facilitar somas
    return { start, end: new Date(end.getTime() + 1) };
  }

  function parseUpstashX(x) {
    // Example: "2025-09-04 15:12:52.76649148 +0000 UTC"
    const r =
      /^(\d{4}-\d{2}-\d{2})\s(\d{2}:\d{2}:\d{2})(\.\d+)?\s\+\d{4}\sUTC$/.exec(
        (x || "").trim()
      );
    if (!r) return null;
    const frac = (r[3] || ".000").slice(1); // digits
    const ms = (frac + "000").slice(0, 3);
    const iso = `${r[1]}T${r[2]}.${ms}Z`;
    const d = new Date(iso);
    return isNaN(d) ? null : d;
  }

  function sumSeries(points, start, endExclusive) {
    if (!Array.isArray(points)) return null;
    let s = 0;
    let any = false;
    for (const p of points) {
      const d = parseUpstashX(p?.x);
      const y = Number(p?.y);
      if (!d || !Number.isFinite(y)) continue;
      if (d >= start && d < endExclusive) {
        s += y;
        any = true;
      }
    }
    return any ? s : null;
  }

  // ---------- period selection ----------
  let mode = "hours";
  let hours = clampInt(url.searchParams.get("hours"), 1, 168, 24);

  let range = null;
  const month = url.searchParams.get("month");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (month) {
    const mr = monthRange(month);
    if (!mr) return json({ ok: false, error: "month inválido (use YYYY-MM)" }, 400);
    range = { start: mr.start, end: mr.end };
    mode = "month";
  } else if (from || to) {
    const dr = dayRange(from, to);
    if (!dr) return json({ ok: false, error: "from/to inválidos (use YYYY-MM-DD)" }, 400);
    range = { start: dr.start, end: dr.end };
    mode = "range";
  } else {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600 * 1000);
    range = { start, end };
  }

  const startISO = range.start.toISOString();
  const endISO = range.end.toISOString();

  // ---------- Upstash stats ----------
  async function fetchUpstashStats() {
    const auth = "Basic " + btoa(`${env.UPSTASH_EMAIL}:${env.UPSTASH_API_KEY}`);
    const res = await fetch(
      `https://api.upstash.com/v2/redis/stats/${encodeURIComponent(env.UPSTASH_DB_ID)}`,
      { headers: { Authorization: auth, Accept: "application/json" } }
    );
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  }

  // ---------- Cloudflare stats ----------
  async function fetchCloudflareMetrics() {
    const query = `
      query($accountTag: String!, $start: DateTime!, $end: DateTime!, $scriptName: String!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            workersInvocationsAdaptive(
              limit: 10000,
              filter: { datetime_geq: $start, datetime_leq: $end, scriptName: $scriptName }
            ) {
              sum {
                requests
                subrequests
                errors
              }
              quantiles {
                cpuTimeP50
                cpuTimeP90
                cpuTimeP99
              }
            }
          }
        }
      }
    `;
    const body = JSON.stringify({
      query,
      variables: {
        accountTag: env.CF_ACCOUNT_TAG,
        start: startISO,
        end: endISO,
        scriptName: env.CF_SCRIPT_NAME,
      },
    });

    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body,
    });

    const j = await res.json().catch(() => null);
    const row =
      j?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0] || null;

    const sum = row?.sum || {};
    const q = row?.quantiles || {};

    return {
      ok: !!row,
      rawOk: res.ok,
      requests: Number(sum.requests ?? 0),
      subrequests: Number(sum.subrequests ?? 0),
      errors: Number(sum.errors ?? 0),
      cpu_p50_us: Number(q.cpuTimeP50 ?? null),
      cpu_p90_us: Number(q.cpuTimeP90 ?? null),
      cpu_p99_us: Number(q.cpuTimeP99 ?? null),
      _errors: j?.errors || null,
    };
  }

  // ---------- run ----------
  const nowISO = new Date().toISOString();

  try {
    const [up, cf] = await Promise.all([fetchUpstashStats(), fetchCloudflareMetrics()]);

    const u = up.data || {};
    // default: current-month totals (Upstash)
    let total_monthly_requests = u.total_monthly_requests ?? u.total_monthly_read_requests ?? null;
    let monthly_reads = u.total_monthly_read_requests ?? null;
    let monthly_writes = u.total_monthly_write_requests ?? null;
    let daily_net_commands = u.daily_net_commands ?? null;
    let current_storage_bytes = u.current_storage ?? u.current_storage_bytes ?? u.current_storage_bytes ?? u.current_storage ?? null;
    let monthly_billing_usd = u.total_monthly_billing ?? null;

    // If month/range requested: compute totals by summing time series, if available
    if (mode === "month" || mode === "range") {
      const reqSum = sumSeries(u.dailyrequests, range.start, range.end);
      const readSum = sumSeries(u.read, range.start, range.end);
      const writeSum = sumSeries(u.write, range.start, range.end);
      const billSum = sumSeries(u.dailybilling, range.start, range.end);

      // only override if we actually have data points in that range
      if (reqSum !== null) total_monthly_requests = reqSum;
      if (readSum !== null) monthly_reads = readSum;
      if (writeSum !== null) monthly_writes = writeSum;
      if (billSum !== null) monthly_billing_usd = billSum;
    }

    return json({
      ok: true,
      at: nowISO,
      period: {
        mode,
        hours: mode === "hours" ? hours : null,
        month: mode === "month" ? month : null,
        from: mode !== "hours" ? startISO.slice(0, 10) : null,
        to: mode !== "hours" ? new Date(range.end.getTime() - 1).toISOString().slice(0, 10) : null,
        status: "success",
        scriptName: env.CF_SCRIPT_NAME,
      },
      upstash: {
        ok: !!up.ok,
        total_monthly_requests: total_monthly_requests ?? null,
        monthly_reads: monthly_reads ?? null,
        monthly_writes: monthly_writes ?? null,
        daily_net_commands: daily_net_commands ?? null,
        current_storage_bytes: u.current_storage ?? u.current_storage_bytes ?? null,
        monthly_billing_usd: monthly_billing_usd ?? null,
      },
      cloudflare: {
        ok: cf.ok,
        requests: cf.requests,
        subrequests: cf.subrequests,
        errors: cf.errors,
        cpu_p50_us: cf.cpu_p50_us,
        cpu_p90_us: cf.cpu_p90_us,
        cpu_p99_us: cf.cpu_p99_us,
      },
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
