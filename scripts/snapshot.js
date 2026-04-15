// scripts/snapshot.js
// Snapshot diário com nome D-1 (ontem) + fechamento do mês anterior no dia 01 (BRT)

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const MONTH_DIR = path.join(process.cwd(), "month");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function fmt2(n) {
  return String(n).padStart(2, "0");
}

// Retorna { y, m, d } no fuso America/Sao_Paulo (BRT)
function getBrtParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA -> YYYY-MM-DD
  const [y, m, d] = fmt.format(date).split("-").map(Number);
  return { y, m, d };
}

function partsToYMD(p) {
  return `${p.y}-${fmt2(p.m)}-${fmt2(p.d)}`;
}

function partsToYM(p) {
  return `${p.y}-${fmt2(p.m)}`;
}

function brtTodayYMD() {
  return partsToYMD(getBrtParts(new Date()));
}

function brtTodayParts() {
  return getBrtParts(new Date());
}

function addDaysBrt(ymd, deltaDays) {
  // ymd: "YYYY-MM-DD" (interpreta como data em BRT e faz +/- dias)
  // Para simplificar, convertemos para Date via UTC e ajustamos por delta.
  // Como usamos apenas +/-1 dia, isso é seguro o suficiente para BRT sem DST.
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // meio-dia UTC evita borda
  dt.setUTCDate(dt.getUTCDate() + deltaDays);

  // Converte de volta para “dia em BRT” usando Intl
  const p = getBrtParts(dt);
  return partsToYMD(p);
}

function prevMonthYM(ym) {
  // ym: "YYYY-MM"
  const [y0, m0] = ym.split("-").map(Number);
  let y = y0, m = m0 - 1;
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${fmt2(m)}`;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch {}
  if (!r.ok || !j || j.ok !== true) {
    throw new Error(`Falha GET ${url} -> ${r.status}: ${txt.slice(0, 400)}`);
  }
  return j;
}

async function main() {
  const base = process.env.METRICS_URL;
  if (!base) {
    console.error("Falta secret METRICS_URL (ex: https://calculadora-status.pages.dev/metrics)");
    process.exit(1);
  }

  ensureDir(DATA_DIR);
  ensureDir(MONTH_DIR);

  // Hoje em BRT
  const todayBrt = brtTodayYMD();

  // Target = D-1 (ontem) em BRT
  const targetDay = addDaysBrt(todayBrt, -1); // "YYYY-MM-DD"
  const targetMonth = targetDay.slice(0, 7);  // "YYYY-MM"

  // === 1) Snapshot diário D-1 ===
  const dailyPath = path.join(DATA_DIR, `${targetDay}.json`);
  if (fs.existsSync(dailyPath)) {
    console.log(`Daily snapshot já existe: data/${targetDay}.json (skip)`);
  } else {
    const url = new URL(base);
    url.searchParams.set("hours", "24");
    url.searchParams.set("ts", String(Date.now())); // cache-buster

    console.log("Fetching daily metrics:", url.toString());
    const data = await fetchJson(url.toString());

    const payload = {
      snapshot_type: "daily_d-1",
      target_day_brt: targetDay,
      fetched_at_utc: new Date().toISOString(),
      source: base,
      data,
    };

    fs.writeFileSync(dailyPath, JSON.stringify(payload, null, 2), "utf-8");
    console.log(`Saved: data/${targetDay}.json`);
  }

  // === 2) Fechamento mensal: somente se HOJE (BRT) for dia 01 ===
  const brt = brtTodayParts();
  if (brt.d === 1) {
    // Mês anterior ao mês atual em BRT
    const prevYM = prevMonthYM(partsToYM(brt)); // ex: se hoje 2026-04, prev -> 2026-03

    const monthPath = path.join(MONTH_DIR, `${prevYM}.json`);
    if (fs.existsSync(monthPath)) {
      console.log(`Monthly close já existe: month/${prevYM}.json (skip)`);
    } else {
      const urlM = new URL(base);
      urlM.searchParams.set("month", prevYM);
      urlM.searchParams.set("detail", "1");
      urlM.searchParams.set("ts", String(Date.now()));

      console.log("Fetching monthly close:", urlM.toString());
      const monthData = await fetchJson(urlM.toString());

      const payloadM = {
        snapshot_type: "monthly_close",
        target_month_brt: prevYM,
        fetched_at_utc: new Date().toISOString(),
        source: base,
        data: monthData,
      };

      fs.writeFileSync(monthPath, JSON.stringify(payloadM, null, 2), "utf-8");
      console.log(`Saved: month/${prevYM}.json`);
    }
  } else {
    console.log("Hoje não é dia 01 (BRT). Fechamento mensal não executado.");
  }
}

main().catch((e) => {
  console.error("Erro:", e?.message || e);
  process.exit(2);
});
