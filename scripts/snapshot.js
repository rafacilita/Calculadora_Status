/**
 * Snapshot CRR5 metrics (Upstash + Cloudflare) via Pages Function /metrics
 *
 * MODES:
 * - daily: grava data/YYYY-MM-DD.json para o "D-1" em America/Sao_Paulo
 * - month_close: só executa no ÚLTIMO DIA DO MÊS (UTC). Grava month/YYYY-MM.json
 *
 * ENV:
 * - METRICS_URL (obrigatório)
 * - MODE = daily | month_close
 * - TZ = America/Sao_Paulo (default)
 * - TARGET_DATE = YYYY-MM-DD (opcional, pra reprocessar manual)
 * - FORCE = "1" (sobrescreve mesmo se já existir)
 */

import fs from "node:fs";
import path from "node:path";

const METRICS_URL = (process.env.METRICS_URL || "").trim();
const MODE = (process.env.MODE || "daily").trim();
const TZ = (process.env.TZ || "America/Sao_Paulo").trim();
const TARGET_DATE = (process.env.TARGET_DATE || "").trim();
const FORCE = (process.env.FORCE || "0").trim() === "1";

if (!METRICS_URL) {
  console.error("ERRO: METRICS_URL não definido.");
  process.exit(1);
}

function ymdInTZ(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date); // YYYY-MM-DD
}

function addQuery(urlStr, params) {
  const u = new URL(urlStr);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function isLastDayOfMonthUTC(d) {
  const tomorrow = new Date(d.getTime());
  tomorrow.setUTCDate(d.getUTCDate() + 1);
  return tomorrow.getUTCMonth() !== d.getUTCMonth();
}

function monthKeyUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithRetry(url, tries = 3) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      const txt = await res.text();
      let json = null;
      try {
        json = JSON.parse(txt);
      } catch {
        throw new Error(`Resposta não-JSON (HTTP ${res.status}): ${txt.slice(0, 200)}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
      }
      return json;
    } catch (e) {
      lastErr = e;
      console.warn(`Tentativa ${i}/${tries} falhou: ${e?.message || e}`);
      if (i < tries) await sleep(800 * i);
    }
  }
  throw lastErr || new Error("Falha desconhecida ao buscar JSON");
}

function isValidMetrics(metricsJson) {
  // Esperado (exemplo):
  // { ok: true, upstash: { ok:true, monthly_reads:..., monthly_writes:... }, cloudflare:{ ok:true, requests:... } }
  if (!metricsJson || metricsJson.ok !== true) return false;
  if (!metricsJson.cloudflare || metricsJson.cloudflare.ok !== true) return false;

  // Upstash precisa estar OK pra snapshot ser útil (senão vira "—" no relatório)
  if (!metricsJson.upstash || metricsJson.upstash.ok !== true) return false;
  if (metricsJson.upstash.monthly_reads == null) return false;
  if (metricsJson.upstash.monthly_writes == null) return false;

  return true;
}

function loadIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

async function main() {
  const now = new Date();

  // month_close: só roda no último dia do mês (UTC)
  if (MODE === "month_close" && !isLastDayOfMonthUTC(now)) {
    console.log("month_close: hoje NÃO é o último dia do mês (UTC). Nada a fazer.");
    return;
  }

  let targetDate = TARGET_DATE;

  if (!targetDate) {
    if (MODE === "daily") {
      // D-1 em TZ (aprox: agora - 24h)
      targetDate = ymdInTZ(new Date(now.getTime() - 24 * 60 * 60 * 1000), TZ);
    } else {
      // month_close: usa o "hoje" em TZ (o fechamento é do mês corrente em UTC)
      targetDate = ymdInTZ(now, TZ);
    }
  }

  const dataDir = path.join(process.cwd(), "data");
  const monthDir = path.join(process.cwd(), "month");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(monthDir, { recursive: true });

  const outPath = path.join(dataDir, `${targetDate}.json`);

  // Se já existe e está válido, não sobrescreve (a não ser FORCE=1)
  if (!FORCE) {
    const prev = loadIfExists(outPath);
    const prevMetrics = prev?.data;
    if (prev && isValidMetrics(prevMetrics)) {
      console.log(`Snapshot ${targetDate} já existe e está OK. Pulando.`);
    } else {
      if (prev) console.log(`Snapshot ${targetDate} existe mas está inválido. Vou sobrescrever.`);
    }
  }

  // Sempre buscar fresh (ts) e sempre pedir 24h pro Cloudflare
  const url = addQuery(METRICS_URL, { hours: 24, ts: Date.now() });
  console.log(`Buscando metrics: ${url}`);

  const metrics = await fetchJsonWithRetry(url, 3);

  if (!isValidMetrics(metrics)) {
    console.error("ERRO: /metrics retornou dados inválidos (Upstash ou Cloudflare não ok).");
    console.error(JSON.stringify(metrics, null, 2));
    process.exit(1);
  }

  // Se já existe válido e não é FORCE, não regrava
  if (!FORCE) {
    const prev = loadIfExists(outPath);
    if (prev && isValidMetrics(prev?.data)) {
      // ok, pula regravação
    } else {
      const snapshot = {
        snapshot_date: targetDate,
        fetched_at_utc: new Date().toISOString(),
        tz: TZ,
        mode: MODE,
        source: METRICS_URL,
        data: metrics,
      };
      fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
      console.log(`Gravado: ${path.relative(process.cwd(), outPath)}`);
    }
  } else {
    const snapshot = {
      snapshot_date: targetDate,
      fetched_at_utc: new Date().toISOString(),
      tz: TZ,
      mode: MODE,
      source: METRICS_URL,
      data: metrics,
    };
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
    console.log(`(FORCE) Gravado: ${path.relative(process.cwd(), outPath)}`);
  }

  // Fechamento mensal (UTC): salva o “total do mês” antes de virar
  if (MODE === "month_close") {
    const mk = monthKeyUTC(now);
    const monthPath = path.join(monthDir, `${mk}.json`);

    const monthFile = {
      month: mk, // YYYY-MM (UTC)
      closed_at_utc: new Date().toISOString(),
      note: "Fechamento mensal via Upstash month-to-date (UTC).",
      source: METRICS_URL,
      totals: {
        total_monthly_requests: metrics.upstash.total_monthly_requests,
        monthly_reads: metrics.upstash.monthly_reads,
        monthly_writes: metrics.upstash.monthly_writes,
        daily_net_commands: metrics.upstash.daily_net_commands,
        current_storage_bytes: metrics.upstash.current_storage_bytes,
        monthly_billing_usd: metrics.upstash.monthly_billing_usd,
      },
    };

    fs.writeFileSync(monthPath, JSON.stringify(monthFile, null, 2));
    console.log(`Fechamento mensal gravado: ${path.relative(process.cwd(), monthPath)}`);
  }
}

main().catch((e) => {
  console.error("FALHA geral:", e?.stack || e?.message || e);
  process.exit(1);
});
