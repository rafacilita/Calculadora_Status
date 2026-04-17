const fs = require("fs");
const path = require("path");

const METRICS_URL = process.env.METRICS_URL;
if (!METRICS_URL) {
  console.error("Missing METRICS_URL secret.");
  process.exit(1);
}

const SNAP_MODE = process.env.SNAP_MODE || "d1"; // d1 | month_guard
const TZ = "America/Sao_Paulo";

function ymdInTZ(date, tz) {
  // en-CA -> YYYY-MM-DD
  return date.toLocaleDateString("en-CA", { timeZone: tz });
}

function ymInTZ(date, tz) {
  const ymd = ymdInTZ(date, tz);
  return ymd.slice(0, 7);
}

function lastDayOfMonth(year, month1to12) {
  // day 0 of next month = last day of current month
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function parseYMD(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function fetchJson(url) {
  const u = url.includes("?") ? `${url}&ts=${Date.now()}` : `${url}?ts=${Date.now()}`;
  const res = await fetch(u, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from METRICS_URL: ${text.slice(0, 300)}`);
  }
  return json;
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isSnapshotBad(j) {
  // “ruim” = não tem estrutura mínima
  if (!j || typeof j !== "object") return true;
  if (!j.upstash || !j.cloudflare) return true;
  if (j.upstash.ok === false && j.cloudflare.ok === false) return true;
  return false;
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

(async () => {
  ensureDir("data");
  ensureDir("month");

  const now = new Date();
  const todaySP = ymdInTZ(now, TZ);

  if (SNAP_MODE === "d1") {
    // snapshot D-1 (ontem no fuso de SP)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const ymd = ymdInTZ(yesterday, TZ);
    const outFile = path.join("data", `${ymd}.json`);

    // Não sobrescreve se já existe e parece ok (protege virada do mês)
    const existing = readJsonIfExists(outFile);
    if (existing && !isSnapshotBad(existing)) {
      console.log(`[d1] ${outFile} já existe e parece ok. Skip.`);
      return;
    }

    const metrics = await fetchJson(METRICS_URL);
    metrics.meta = {
      captured_at_utc: new Date().toISOString(),
      mode: "d1",
      target_day_sp: ymd
    };

    writeJson(outFile, metrics);
    console.log(`[d1] wrote ${outFile}`);
    return;
  }

  // month_guard: só age se HOJE (SP) é o último dia do mês
  const { y, m, d } = parseYMD(todaySP);
  const last = lastDayOfMonth(y, m);
  if (d !== last) {
    console.log(`[month_guard] Hoje (${todaySP}) não é último dia do mês. Skip.`);
    return;
  }

  const metrics = await fetchJson(METRICS_URL);
  metrics.meta = {
    captured_at_utc: new Date().toISOString(),
    mode: "month_guard",
    target_day_sp: todaySP,
    target_month_sp: `${y}-${String(m).padStart(2, "0")}`
  };

  // salva snapshot do ÚLTIMO DIA (pra não depender do dia 1, quando pode ter reset)
  const dayFile = path.join("data", `${todaySP}.json`);
  const oldDay = readJsonIfExists(dayFile);

  // aqui PODE sobrescrever se o novo for “mais completo”
  if (!oldDay || isSnapshotBad(oldDay) || (oldDay.meta?.captured_at_utc < metrics.meta.captured_at_utc)) {
    writeJson(dayFile, metrics);
    console.log(`[month_guard] wrote ${dayFile}`);
  } else {
    console.log(`[month_guard] ${dayFile} já está melhor/mais novo. Skip.`);
  }

  // fechamento mensal (congela o mês)
  const ym = ymInTZ(now, TZ);
  const monthFile = path.join("month", `${ym}.json`);
  const oldMonth = readJsonIfExists(monthFile);

  if (!oldMonth || isSnapshotBad(oldMonth) || (oldMonth.meta?.captured_at_utc < metrics.meta.captured_at_utc)) {
    writeJson(monthFile, metrics);
    console.log(`[month_guard] wrote ${monthFile}`);
  } else {
    console.log(`[month_guard] ${monthFile} já está melhor/mais novo. Skip.`);
  }
})().catch((e) => {
  console.error("snapshot failed:", e);
  process.exit(1);
});
