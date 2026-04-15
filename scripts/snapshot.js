// scripts/snapshot.js
// Snapshot diário do /metrics (modo economia): 1 GET, salva em /data/YYYY-MM-DD.json

import fs from "node:fs";
import path from "node:path";

function ymdUTC(date = new Date()) {
  // usa UTC para consistência no cron
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function main() {
  const baseUrl = process.env.METRICS_URL;
  if (!baseUrl) {
    console.error("Falta METRICS_URL (ex: https://calculadora-status.pages.dev/metrics)");
    process.exit(1);
  }

  const dateStr = process.env.SNAPSHOT_DATE || ymdUTC();
  const outDir = path.join(process.cwd(), "data");
  const outFile = path.join(outDir, `${dateStr}.json`);

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Evita regravar o mesmo dia (zero ruído)
  if (fs.existsSync(outFile)) {
    console.log(`Snapshot já existe: ${outFile} (skip)`);
    return;
  }

  const url = new URL(baseUrl);
  // puxa 24h como padrão, e sem detail (leve)
  if (!url.searchParams.has("hours")) url.searchParams.set("hours", "24");
  // cache buster
  url.searchParams.set("ts", String(Date.now()));

  console.log("Buscando:", url.toString());

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "Accept": "application/json" }
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok || !json || json.ok !== true) {
    console.error("Falha ao obter métricas:", res.status, text.slice(0, 1000));
    process.exit(2);
  }

  const payload = {
    snapshot_date_utc: dateStr,
    fetched_at_utc: new Date().toISOString(),
    source: baseUrl,
    data: json
  };

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf-8");
  console.log("Salvo:", outFile);
}

main().catch((e) => {
  console.error("Erro:", e);
  process.exit(3);
});
