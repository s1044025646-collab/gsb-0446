import fs from "node:fs";
import path from "node:path";
import { checksum } from "./nmea";
import { startServer } from "./server";
import { Store } from "./store";

function dbPathFromArgs(args: string[]): string {
  const i = args.indexOf("--db");
  const custom = i !== -1 ? args[i + 1] : process.env.NMEA_DB;
  if (custom) {
    fs.mkdirSync(path.dirname(path.resolve(custom)), { recursive: true });
    return custom;
  }
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "nmea.db");
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

/** 给 NMEA 正文补校验和，生成完整语句（仅供演示/测试造数）。 */
export function sentence(body: string): string {
  return `$${body}*${checksum(body).toString(16).toUpperCase().padStart(2, "0")}`;
}

function print(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const dbPath = dbPathFromArgs(args);
  const store = new Store(dbPath);
  switch (cmd) {
    case "serve": {
      const port = Number(argValue(args, "port") ?? 0);
      const { port: actual } = await startServer(store, port);
      console.log(`API 服务已启动: http://127.0.0.1:${actual}/api （数据库: ${dbPath}）`);
      return;
    }
    case "new": {
      print(store.createDataset(argValue(args, "name") ?? "未命名"));
      break;
    }
    case "datasets": {
      print(store.listDatasets());
      break;
    }
    case "import": {
      const dataset = Number(argValue(args, "dataset"));
      const file = argValue(args, "file");
      const requestId = argValue(args, "request-id");
      const source = argValue(args, "source");
      const utcDate = argValue(args, "date");
      if (!dataset || !file || !requestId || !source) {
        throw new Error("用法: import --dataset <id> --file <path> --request-id <id> --source <name> [--date YYYY-MM-DD]");
      }
      const resolved = path.resolve(file);
      if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
      const text = fs.readFileSync(resolved, "utf8");
      print(store.importText(dataset, { requestId, source, utcDate, text }));
      break;
    }
    case "lines": {
      print(store.listLines(Number(argValue(args, "dataset"))));
      break;
    }
    case "pairs": {
      const tol = Number(argValue(args, "tolerance") ?? 1e-4);
      print(store.queryPairs(Number(argValue(args, "dataset")), tol, {
        source: argValue(args, "source"),
        date: argValue(args, "date"),
        second: argValue(args, "second") !== undefined ? Number(argValue(args, "second")) : undefined,
      }));
      break;
    }
    case "report": {
      const tol = Number(argValue(args, "tolerance") ?? 1e-4);
      const r = store.createReport(Number(argValue(args, "dataset")), tol);
      console.log(`报告已冻结，id=${r.id}，共 ${r.pairs.length} 个配对键`);
      break;
    }
    case "export": {
      const id = Number(argValue(args, "report"));
      const report = store.getReport(id);
      const out = argValue(args, "out");
      const payload = JSON.stringify({ format: "nmea-pairing-report/1", ...report }, null, 2);
      if (out) {
        fs.writeFileSync(out, payload, "utf8");
        console.log(`已导出: ${out}`);
      } else {
        console.log(payload);
      }
      break;
    }
    case "demo": {
      runDemo(store);
      break;
    }
    default:
      console.log("用法: node dist/src/cli.js <serve|new|datasets|import|lines|pairs|report|export|demo> [选项] [--db <路径>]");
  }
  store.close();
}

function runDemo(store: Store): void {
  const ds = store.createDataset("演示日志集");
  const text1 = [
    sentence("GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,"),
    sentence("GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W"),
  ].join("\r\n") + "\r\n";
  console.log("导入 receiver-A:", store.importText(ds.id, {
    requestId: "demo-1", source: "receiver-A", utcDate: "1994-03-23", text: text1,
  }));
  const text2 = [
    sentence("GPGGA,123519,4807.038,N,01131.000,E,1,05,1.2,100.0,M,46.9,M,,"),
    sentence("GPRMC,123520,V,,,,,,,230394,,,N"),
    sentence("GPGGA,123521,4807.500,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,"),
    sentence("GPRMC,123521,A,4807.100,N,01131.000,E,010.0,084.4,230394,003.1,W"),
  ].join("\n") + "\n";
  console.log("导入 receiver-B:", store.importText(ds.id, {
    requestId: "demo-2", source: "receiver-B", utcDate: "1994-03-23", text: text2,
  }));
  const pairs = store.queryPairs(ds.id, 1e-4);
  console.log(`\n配对结果（${pairs.length} 组）:`);
  print(pairs);
  const report = store.createReport(ds.id, 1e-4);
  console.log(`\n报告已冻结: id=${report.id}`);
  console.log("演示坐标: 4807.038,N => 48.1173；01131.000,E => 约 11.5166667");
}

main().catch((e) => {
  console.error(`错误: ${e.message ?? e}`);
  process.exit(1);
});
