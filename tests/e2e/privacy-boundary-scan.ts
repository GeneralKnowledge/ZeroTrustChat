#!/usr/bin/env tsx
/**
 * Scans client + package *source* for accidental network usage outside server-interface.
 * Fails if fetch/WebSocket/etc. appear in forbidden modules.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

const FORBIDDEN_PATTERNS = [
  /\bfetch\s*\(/,
  /\bnew\s+WebSocket\b/,
  /\bXMLHttpRequest\b/,
  /\bfrom\s+["']axios["']/,
  /\bfrom\s+["']node:http["']/,
  /\bfrom\s+["']node:net["']/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".turbo") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const violations: string[] = [];

// Client source — no direct network
for (const file of walk(join(ROOT, "apps", "client", "src"))) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(src)) {
      violations.push(`${rel} matches ${pat}`);
    }
  }
}

// Packages except server-interface — no WebSocket/fetch
for (const pkg of ["crypto", "protocol", "shared", "test-utils"]) {
  for (const file of walk(join(ROOT, "packages", pkg, "src"))) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, "utf8");
    if (/\bnew\s+WebSocket\b/.test(src) || /\bfetch\s*\(/.test(src)) {
      violations.push(`${rel} uses network outside server-interface`);
    }
  }
}

// server-interface MUST use WebSocket (positive check)
const siSrc = readFileSync(join(ROOT, "packages", "server-interface", "src", "index.ts"), "utf8");
if (!/\bnew\s+WebSocket\b/.test(siSrc)) {
  violations.push("packages/server-interface/src/index.ts must construct WebSocket");
}

if (violations.length) {
  console.error("Privacy boundary violations:");
  for (const v of violations) console.error(" -", v);
  process.exit(1);
}

console.log("Privacy boundary scan: OK (no direct network I/O outside server-interface)");
