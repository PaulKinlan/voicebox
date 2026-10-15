#!/usr/bin/env node
// Run only as a separate fleet-heavy holder. The measured suite is a different process outside the queue.
import { Worker } from "node:worker_threads";
import { hostCores, loadavg1m } from "../lib/host-load.mjs";

const target = Number(process.argv[2]);
if (!Number.isFinite(target) || target < 0) process.exit(2);
const count = Math.max(1, Math.min(6, hostCores().available_parallelism - 1));
const workers = Array.from({ length: count }, () => new Worker(`while (true) { Math.sqrt(Math.random()); }`, { eval: true }));
let finished = false;
function stop(code = 0) {
  if (finished) return;
  finished = true;
  clearInterval(interval);
  clearTimeout(limit);
  for (const worker of workers) worker.terminate();
  process.exit(code);
}
// Readiness is an OBSERVED load reading, never an asserted lock label. Parent verifies this process is alive.
const interval = setInterval(() => {
  const reading = loadavg1m();
  if (reading !== null && reading >= target) {
    process.stdout.write(`READY ${reading}\n`);
    clearInterval(interval);
  }
}, 500);
const limit = setTimeout(() => stop(3), 60000);
process.stdin.resume();
process.stdin.on("end", () => stop());
process.on("SIGTERM", () => stop(143));
