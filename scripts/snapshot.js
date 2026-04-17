// scripts/snapshot.js
import fs from "fs/promises";
import path from "path";

const METRICS_URL = process.env.METRICS_URL || "";
const TZ = process.env.TZ || "America/Sao_Paulo";
const RUN_CRON = process.env.RUN_CRON || "";

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
    await writeJsonAtomic(path.join("data", `${target}.json`), out);
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
  try {
    const { url, data } = await fetchMetrics24h();
    const out = {
      month: monthKey,
      snapshot_date: today,
      fetched_at_utc: new Date().toISOString(),
      tz: TZ,
      mode: "month-close",
      source: url,
      data,
    };
    await writeJsonAtomic(path.join("month", `${monthKey}.json`), out);
    console.log(`[month-close] wrote month/${monthKey}.json`);
  } catch (e) {
    await saveFailedSnapshot("month-close", today, e);
    throw e;
  }
}

async function main() {
  // Decide pelo cron que disparou
  if (RUN_CRON === "10 3 * * *") {
    await runDaily();
    return;
  }
  if (RUN_CRON === "55 2 * * *") {
    await runMonthCloseCandidate();
    return;
  }

  // Manual: default daily
  console.log(`[manual] RUN_CRON="${RUN_CRON}" -> rodando daily`);
  await runDaily();
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
