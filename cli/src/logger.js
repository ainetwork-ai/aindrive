import pino from "pino";
export const log = pino({
  level: process.env.AINDRIVE_LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  base: { ns: "aindrive" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
export const trace = log.child({ ns: "aindrive.trace" });
