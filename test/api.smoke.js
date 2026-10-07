// API 冒烟脚本：node test/api.smoke.js（需先 npm run build）
const { Store } = require("../dist/src/store");
const { startServer } = require("../dist/src/server");

(async () => {
  const store = new Store("data/smoke.db");
  const { server, port } = await startServer(store, 0);
  const base = `http://127.0.0.1:${port}/api`;
  const post = (p, body) => fetch(base + p, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json());

  const ds = await post("/datasets", { name: "smoke" });
  console.log("dataset:", ds);
  const text = [
    "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47",
    "$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A",
    "$BROKEN",
  ].join("\r\n") + "\r\n";
  console.log("import:", await post(`/datasets/${ds.id}/imports`, {
    requestId: "s1", source: "A", utcDate: "1994-03-23", text,
  }));
  console.log("import(重复):", await post(`/datasets/${ds.id}/imports`, {
    requestId: "s1", source: "A", utcDate: "1994-03-23", text,
  }));
  const lines = await fetch(`${base}/datasets/${ds.id}/lines`).then((r) => r.json());
  console.log("坏行诊断:", lines[2].diagnostics);
  const pairs = await fetch(`${base}/datasets/${ds.id}/pairs`).then((r) => r.json());
  console.log("pairs[0].status:", pairs[0].status);
  const report = await post(`/datasets/${ds.id}/reports`, { toleranceDeg: 0.0001 });
  const exp = await fetch(`${base}/reports/${report.id}/export`).then((r) => r.json());
  console.log("export:", exp.format, "pairs:", exp.pairs.length, "rules:", exp.rulesVersion);
  const notFound = await fetch(`${base}/datasets/999/lines`);
  console.log("404:", notFound.status, (await notFound.json()).error.code);
  server.close(); store.close(); setTimeout(()=>process.exit(0),100);
})().catch((e) => { console.error(e); process.exit(1); });
