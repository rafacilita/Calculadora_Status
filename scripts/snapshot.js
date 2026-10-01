// scripts/snapshot.js
import fs from "fs/promises";
import path from "path";

const METRICS_URL = process.env.METRICS_URL || "";
const TZ = process.env.TZ || "America/Sao_Paulo";
const RUN_CRON = process.env.RUN_CRON || "";
// Para execução manual (workflow_dispatch): "daily" | "month-close"
const SNAPSHOT_MODE = process.env.SNAPSHOT_MODE || "";

// Os contadores total_monthly_* do Upstash zeram às 00:00 UTC do dia 1
// (= 21:00 BRT do último dia do mês). Qualquer captura depois disso perde o
// último dia inteiro, por isso o fechamento mensal precisa rodar ANTES das 21:00 BRT.
const DAILY_CRONS = new Set(["37 9 * * *"]);
const MONTH_CLOSE_CRONS = new Set(["40 21 * * *", "20 22 * * *", "0 23 * * *"]);

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 6000;
const FETCH_TIMEOUT = 15000;

if (!METRICS_URL) {
  console.error("Falta METRICS_URL");
  process.exit(1);
}

function isoDateInTZ(date, tz) {
  // en-CA => YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function todayTZ() {
  return isoDateInTZ(new Date(), TZ);
}

function yesterdayTZ() {
  return isoDateInTZ(addDays(new Date(), -1), TZ);
}

function isLastDayOfMonth(isoDate) {
  // isoDate: YYYY-MM-DD
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.getUTCMonth() !== dt.getUTCMonth();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJsonAtomic(filePath, obj) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf-8");
  await fs.rename(tmp, filePath);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function monthlyWritesOf(snap) {
  const v = snap?.data?.upstash?.monthly_writes;
  return Number.isFinite(v) ? v : null;
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    return r;
  } finally {
    clearTimeout(t);
  }
}

async function fetchMetrics24h() {
  const u = new URL(METRICS_URL);
  u.searchParams.set("hours", "24");
  u.searchParams.set("ts", String(Date.now()));

  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    u.searchParams.set("ts", String(Date.now()));
    const url = u.toString();
    console.log(`[fetch attempt ${attempt}/${MAX_RETRIES}] ${url}`);

    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            "user-agent": "crr5-snapshot-bot",
          },
        },
        FETCH_TIMEOUT
      );

      const text = await res.text();

      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        console.warn(`  -> ${lastErr.message}`);
      } else {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          lastErr = new Error(`JSON inválido: ${text.slice(0, 200)}`);
          console.warn(`  -> ${lastErr.message}`);
          json = null;
        }

        if (json) {
          if (json.ok !== true) {
            lastErr = new Error(`metrics ok=false: ${JSON.stringify(json).slice(0, 250)}`);
            console.warn(`  -> ${lastErr.message}`);
          } else {
            console.log("  -> OK");
            return { url, data: json };
          }
        }
      }
    } catch (e) {
      lastErr = e;
      console.warn(`  -> Exceção: ${e?.message || String(e)}`);
    }

    if (attempt < MAX_RETRIES) {
      const wait = RETRY_DELAY_MS * attempt;
      console.log(`  -> aguardando ${wait}ms…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  throw lastErr || new Error("fetchMetrics24h: todas as tentativas falharam");
}

async function saveFailedSnapshot(label, targetDate, error) {
  const failedPath = path.join("data", "_failed", `${targetDate}.json`);
  await writeJsonAtomic(failedPath, {
    ok: false,
    snapshot_date: targetDate,
    captured_at_utc: new Date().toISOString(),
    tz: TZ,
    mode: label,
    error: String(error?.message || error).slice(0, 600),
  });
  console.error(`[${label}] salvo em ${failedPath}`);
}

async function runDaily() {
  const target = yesterdayTZ(); // D-1 em BRT
  const targetPath = path.join("data", `${target}.json`);
  const lastDay = isLastDayOfMonth(target);

  if (lastDay) {
    // O fechamento pré-reset (runMonthCloseCandidate) já gravou o último dia com
    // os contadores ainda válidos; a captura da manhã do dia 1 só veria zeros.
    const existing = await readJsonIfExists(targetPath);
    if (existing?.mode === "month-close") {
      console.log(`[daily] data/${target}.json já veio do fechamento pré-reset. Skip.`);
      return;
    }
  }

  try {
    const { url, data } = await fetchMetrics24h();
    const out = {
      snapshot_date: target,
      fetched_at_utc: new Date().toISOString(),
      tz: TZ,
      mode: "daily",
      source: url,
      data,
    };
    if (lastDay) {
      out.warning =
        "Captura após o reset mensal do Upstash (00:00 UTC do dia 1): monthly_* não refletem o último dia. Nenhum fechamento pré-reset foi gravado.";
      console.warn(`[daily] ${out.warning}`);
    }
    await writeJsonAtomic(targetPath, out);
    console.log(`[daily] wrote data/${target}.json`);
  } catch (e) {
    await saveFailedSnapshot("daily", target, e);
    throw e;
  }
}

async function runMonthCloseCandidate() {
  // Só faz algo se HOJE (BRT) for último dia do mês
  const today = todayTZ();
  if (!isLastDayOfMonth(today)) {
    console.log(`[month-close] hoje (${today}) não é último dia do mês. Skip.`);
    return;
  }

  const monthKey = today.slice(0, 7); // YYYY-MM
  const monthPath = path.join("month", `${monthKey}.json`);
  const dayPath = path.join("data", `${today}.json`);

  try {
    const { url, data } = await fetchMetrics24h();
    const writes = monthlyWritesOf({ data });

    // Guarda 1: se o acumulado veio MENOR que o do dia anterior, o Upstash já zerou
    // (cron atrasou para depois das 21:00 BRT). Gravar agora destruiria o mês inteiro.
    const prevDay = await readJsonIfExists(path.join("data", `${yesterdayTZ()}.json`));
    const prevWrites = monthlyWritesOf(prevDay);
    if (writes !== null && prevWrites !== null && writes < prevWrites) {
      console.warn(
        `[month-close] monthly_writes=${writes} < ontem=${prevWrites}: contadores já zeraram. Não grava.`
      );
      return;
    }

    // Guarda 2: há vários horários candidatos no mesmo dia; só substitui a captura
    // anterior se esta for mais completa (acumulado maior ou igual).
    const existing = await readJsonIfExists(monthPath);
    const existingWrites = monthlyWritesOf(existing);
    if (existing?.month === monthKey && existingWrites !== null && writes !== null && writes < existingWrites) {
      console.log(`[month-close] captura anterior (${existingWrites}) é mais completa que esta (${writes}). Skip.`);
      return;
    }

    const fetched_at_utc = new Date().toISOString();
    const out = {
      month: monthKey,
      snapshot_date: today,
      fetched_at_utc,
      tz: TZ,
      mode: "month-close",
      source: url,
      data,
    };
    await writeJsonAtomic(monthPath, out);
    console.log(`[month-close] wrote month/${monthKey}.json (monthly_writes=${writes})`);

    // O mesmo payload vale como snapshot do último dia: é a única captura do dia
    // feita antes do reset, então o delta "último dia − penúltimo" sai correto.
    await writeJsonAtomic(dayPath, { ...out, month: undefined });
    console.log(`[month-close] wrote data/${today}.json (pré-reset)`);
  } catch (e) {
    await saveFailedSnapshot("month-close", today, e);
    throw e;
  }
}

async function main() {
  if (SNAPSHOT_MODE === "month-close" || MONTH_CLOSE_CRONS.has(RUN_CRON)) {
    await runMonthCloseCandidate();
    return;
  }
  if (SNAPSHOT_MODE === "daily" || DAILY_CRONS.has(RUN_CRON)) {
    await runDaily();
    return;
  }

  // Manual sem modo informado: default daily
  console.log(`[manual] RUN_CRON="${RUN_CRON}" SNAPSHOT_MODE="${SNAPSHOT_MODE}" -> rodando daily`);
  await runDaily();
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
