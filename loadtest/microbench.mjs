import { validateLogEntry } from "../src/lib/validation.js";

const N = 100_000;
const rows = [];
for (let i = 0; i < N; i++) {
  rows.push({
    timestamp: new Date(Date.now() - Math.random() * 30_000).toISOString(),
    level: ["debug", "info", "info", "info", "warn", "error"][i % 6],
    service: "checkout",
    message: `payment declined (${i})`,
    attributes: {
      user_id: String(i),
      request_id: `checkout-${i}`,
      region: "eu-west",
      retries: i % 4,
      total_ms: i % 5000,
    },
  });
}

let t0 = performance.now();
for (let i = 0; i < N; i++) validateLogEntry(rows[i]);
let t1 = performance.now();
console.log(`validateLogEntry x${N}: ${(t1 - t0).toFixed(1)}ms (${((N / ((t1 - t0) / 1000)) / 1000).toFixed(2)}k/s)`);

t0 = performance.now();
for (let i = 0; i < N; i++) new Date(rows[i].timestamp).toISOString();
t1 = performance.now();
console.log(`Date->ISO x${N}: ${(t1 - t0).toFixed(1)}ms`);

t0 = performance.now();
for (let i = 0; i < N; i++) JSON.stringify(rows[i].attributes);
t1 = performance.now();
console.log(`JSON.stringify(attrs) x${N}: ${(t1 - t0).toFixed(1)}ms`);

t0 = performance.now();
for (let i = 0; i < N; i++) JSON.stringify(rows[i]);
t1 = performance.now();
console.log(`JSON.stringify(row) x${N}: ${(t1 - t0).toFixed(1)}ms`);