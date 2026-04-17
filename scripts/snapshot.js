// scripts/snapshot.js
import fs from "fs";
import path from "path";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymdInTZ(date, tz) {
  // Retorna YYYY-MM-DD no fuso tz
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function hmInTZ(date, tz) {
  // Retorna HH:MM no fuso tz
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("hour")}:${get("minute")}`;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} :: ${text.slice(0, 200)}`);
  }
  if (!json || json.ok !== true) {
    throw new Error(`Resposta inválida do metrics: ${text.slice(0, 200)}`);
  }
  return json;
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

(async () => {
  const TZ = process.env.TZ || "America/Sao_Paulo";
  const METRICS_URL = process.env.METRICS_URL;

  if (!METRICS_URL) {
    console.error("Faltou METRICS_URL (secret).");
    process.exit(1);
  }

  const now = new Date();
  const nowHM = hmInTZ(now, TZ);
  const todayYMD = ymdInTZ(now, TZ);

  // Detecta o modo baseado no horário BRT aproximado
  // (GitHub schedule pode atrasar alguns minutos)
  const isPrecloseWindow = (nowHM >= "23:30" && nowHM <= "23:59");
  const isD1Window = (nowHM >= "00:00" && nowHM <= "00:40");

  const mode = isPrecloseWindow ? "preclose" : (isD1Window ? "d-1" : "manual/other");

  // targetDate:
  // - preclose: salva o DIA ATUAL (quase fechado)
  // - d-1: salva o DIA ANTERIOR
  const targetDate = mode === "preclose"
    ? todayYMD
    : ymdInTZ(addDays(now, -1), TZ);

  // No dia 1, o d-1 tentaria salvar o último dia do mês anterior,
  // mas os contadores do Upstash podem já ter “resetado”.
  // Para não sobrescrever um fechamento bom (pré-fechamento de ontem),
  // a gente simplesmente não grava o d-1 no dia 1.
  const todayDay = Number(todayYMD.slice(8, 10));
  if (mode === "d-1" && todayDay === 1) {
    console.log(`[skip] Dia 1 detectado. Pulando d-1 para evitar reset do Upstash sobrescrever o último dia do mês anterior.`);
    process.exit(0);
  }

  console.log(`[run] TZ=${TZ} now=${todayYMD} ${nowHM} mode=${mode} target=${targetDate}`);

  const metrics = await fetchJson(METRICS_URL);

  // normaliza o payload do snapshot (mantém simples e estável)
  const snap = {
    ok: true,
    captured_at: new Date().toISOString(),
    tz: TZ,
    mode,
    target_date: targetDate,
    upstash: metrics.upstash || null,
    cloudflare: metrics.cloudflare || null,
    period: metrics.period || null,
  };

  ensureDir("data");
  ensureDir("month");

  const dataFile = path.join("data", `${targetDate}.json`);
  writeJson(dataFile, snap);
  console.log(`[write] ${dataFile}`);

  // Fechamento mensal: só faz no preclose quando amanhã é dia 1
  if (mode === "preclose") {
    const tomorrowYMD = ymdInTZ(addDays(now, 1), TZ);
    const tomorrowDay = Number(tomorrowYMD.slice(8, 10));

    if (tomorrowDay === 1) {
      const monthKey = targetDate.slice(0, 7); // YYYY-MM (mês que está fechando)
      const monthFile = path.join("month", `${monthKey}.json`);

      const monthClose = {
        ok: true,
        closed_month: monthKey,
        closed_at: new Date().toISOString(),
        tz: TZ,
        source: "preclose",
        snapshot_file: `data/${targetDate}.json`,
        upstash: metrics.upstash || null,
        cloudflare: metrics.cloudflare || null,
      };

      writeJson(monthFile, monthClose);
      console.log(`[month-close] ${monthFile}`);
    }
  }

  process.exit(0);
})().catch((e) => {
  console.error("[fatal]", e?.stack || e?.message || String(e));
  process.exit(1);
});
