import fs from "fs/promises";
import path from "path";

const TZ = process.env.TZ || "America/Sao_Paulo";
const RUN_MODE = (process.env.RUN_MODE || "daily").toLowerCase();
const METRICS_URL = process.env.METRICS_URL;

if (!METRICS_URL) {
  throw new Error("Falta METRICS_URL (configure em GitHub Secrets).");
}

function ymdInTZ(date, tz) {
  // en-CA costuma retornar YYYY-MM-DD
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return s; // YYYY-MM-DD
}

function parseYMD(ymd) {
  const [y, m, d] = ymd.split("-").map((n) => parseInt(n, 10));
  return { y, m, d };
}

// cria um Date em UTC no meio do dia (12:00) pra evitar treta de virada/DST
function dateFromYMDNoonUTC(ymd) {
  const { y, m, d } = parseYMD(ymd);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function addDaysYMD(ymd, deltaDays, tz) {
  const base = dateFromYMDNoonUTC(ymd);
  const next = new Date(base.getTime() + deltaDays * 86400000);
  return ymdInTZ(next, tz);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJsonIfExists(filePath) {
  try {
    const txt = await fs.readFile(filePath, "utf-8");
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

function isGoodSnapshot(obj) {
  // formato esperado: { data: { ok, upstash:{ok}, cloudflare:{ok} } }
  const d = obj?.data;
  return d?.ok === true && d?.upstash?.ok === true && d?.cloudflare?.ok === true;
}

async function fetchMetrics24h() {
  const u = new URL(METRICS_URL);

  // garante 24h SEMPRE (isso evita Upstash=null)
  u.searchParams.set("hours", "24");

  // cache-buster
  u.searchParams.set("ts", String(Date.now()));

  const res = await fetch(u.toString(), {
    method: "GET",
    headers: {
      "accept": "application/json",
      "user-agent": "crr5-snapshot-bot",
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`METRICS_URL HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Resposta do /metrics não é JSON: ${text.slice(0, 300)}`);
  }

  if (json?.ok !== true) {
    throw new Error(`/metrics retornou ok=false: ${text.slice(0, 300)}`);
  }

  return { url: u.toString(), data: json };
}

async function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf-8");
  await fs.rename(tmp, filePath);
}

function isLastDayOfMonth(ymd, tz) {
  const tomorrow = addDaysYMD(ymd, 1, tz);
  const { d } = parseYMD(tomorrow);
  return d === 1;
}

async function runDaily() {
  // Hoje em BRT
  const today = ymdInTZ(new Date(), TZ);
  // D-1 em BRT
  const target = addDaysYMD(today, -1, TZ);

  const outPath = path.join("data", `${target}.json`);
  const existing = await readJsonIfExists(outPath);

  // Se já está bom, não mexe
  if (existing && isGoodSnapshot(existing)) {
    console.log(`[daily] Já existe snapshot bom: ${outPath} — pulando.`);
    return;
  }

  const { url, data } = await fetchMetrics24h();

  const snapshot = {
    snapshot_date_local: target,
    captured_at_utc: new Date().toISOString(),
    tz: TZ,
    mode: "daily(D-1)",
    source: url,
    data,
  };

  // Se Upstash vier ruim, falha (melhor falhar do que gravar lixo)
  if (!isGoodSnapshot(snapshot)) {
    console.error("[daily] Snapshot inválido (Upstash/Cloudflare não ok).");
    console.error(JSON.stringify(snapshot, null, 2));
    throw new Error("Snapshot inválido: upstash ok=false ou cloudflare ok=false");
  }

  await writeJsonAtomic(outPath, snapshot);
  console.log(`[daily] Gravado: ${outPath}`);

  // Fechamento mensal automático (opcional):
  // se o TARGET (D-1) foi o último dia do mês, cria month/YYYY-MM.json
  if (isLastDayOfMonth(target, TZ)) {
    const monthKey = target.slice(0, 7); // YYYY-MM
    const monthPath = path.join("month", `${monthKey}.json`);

    const monthExisting = await readJsonIfExists(monthPath);
    if (!monthExisting || !isGoodSnapshot(monthExisting)) {
      await writeJsonAtomic(monthPath, snapshot);
      console.log(`[daily] Fechamento mensal criado/atualizado: ${monthPath}`);
    } else {
      console.log(`[daily] Fechamento mensal já existe bom: ${monthPath}`);
    }
  }
}

async function runMonthCloseCandidate() {
  // roda só nos dias 28-31 às 23:58 BRT (cron candidato).
  // aqui a gente checa se HOJE é o último dia do mês em BRT.
  const today = ymdInTZ(new Date(), TZ);

  if (!isLastDayOfMonth(today, TZ)) {
    console.log(`[month-close] Hoje (${today}) NÃO é último dia do mês — saindo sem fazer nada.`);
    return;
  }

  const { url, data } = await fetchMetrics24h();

  const snapshot = {
    snapshot_date_local: today,
    captured_at_utc: new Date().toISOString(),
    tz: TZ,
    mode: "month-close(last-day)",
    source: url,
    data,
  };

  if (!isGoodSnapshot(snapshot)) {
    console.error("[month-close] Snapshot inválido (Upstash/Cloudflare não ok).");
    console.error(JSON.stringify(snapshot, null, 2));
    throw new Error("Month-close inválido: upstash ok=false ou cloudflare ok=false");
  }

  const monthKey = today.slice(0, 7); // YYYY-MM
  const monthPath = path.join("month", `${monthKey}.json`);

  await writeJsonAtomic(monthPath, snapshot);
  console.log(`[month-close] Fechamento mensal gravado: ${monthPath}`);
}

async function main() {
  console.log(`RUN_MODE=${RUN_MODE} TZ=${TZ}`);

  await ensureDir("data");
  await ensureDir("month");

  if (RUN_MODE === "daily") {
    await runDaily();
    return;
  }

  if (RUN_MODE === "month-close") {
    await runMonthCloseCandidate();
    return;
  }

  // fallback
  await runDaily();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
