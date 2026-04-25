import { db } from "./db.js";
import { log } from "./logger.js";

const maintenanceLog = log.child({ ns: "aindrive.sqlite-maintenance" });

const INTERVAL_MS =
  Number(process.env.AINDRIVE_SQLITE_MAINTENANCE_INTERVAL_MS) || 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;

let running = false;

function runMaintenance() {
  if (running) {
    maintenanceLog.info("sqlite maintenance skipped — previous pass still running");
    return;
  }
  running = true;
  const start = Date.now();
  maintenanceLog.info("sqlite maintenance starting");
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    db.pragma("optimize");
    const elapsed = Date.now() - start;
    maintenanceLog.info({ elapsed }, "sqlite maintenance completed");
  } catch (err) {
    const elapsed = Date.now() - start;
    maintenanceLog.info({ elapsed, err: String(err) }, "sqlite maintenance error");
  } finally {
    running = false;
  }
}

export function startSqliteMaintenance() {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.AINDRIVE_SQLITE_NO_MAINTENANCE === "1"
  ) {
    return;
  }

  setTimeout(() => {
    runMaintenance();
    setInterval(runMaintenance, INTERVAL_MS).unref();
  }, INITIAL_DELAY_MS).unref();
}
