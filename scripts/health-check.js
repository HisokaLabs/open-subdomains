#!/usr/bin/env node

"use strict";

const dns = require("node:dns/promises");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const META_PATH = path.join(ROOT, "domains", "_meta.json");
const QUERY_TIMEOUT_MS = 10_000;

function loadZones() {
  if (!fs.existsSync(META_PATH)) {
    console.error("health: domains/_meta.json not found");
    process.exit(1);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
    const meta = raw._meta || raw;
    const zones = Array.isArray(meta.zones) ? meta.zones.map((z) => String(z).toLowerCase()) : [];
    if (!zones.length) {
      console.error("health: no zones listed in domains/_meta.json");
      process.exit(1);
    }
    return zones;
  } catch (err) {
    console.error(`health: failed to read ${META_PATH}: ${err.message}`);
    process.exit(1);
  }
}

async function resolveSoaWithTimeout(zone, timeoutMs) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([
    dns.resolveSoa(zone),
    timeoutPromise,
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  const zones = loadZones();
  let failed = false;

  const results = await Promise.allSettled(
    zones.map(async (zone) => {
      const soa = await resolveSoaWithTimeout(zone, QUERY_TIMEOUT_MS);
      return { zone, soa };
    })
  );

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const res = results[i];
    if (res.status === "fulfilled") {
      const { soa } = res.value;
      console.log(`ok    ${zone}  SOA ${soa.nsname} (serial ${soa.serial})`);
    } else {
      failed = true;
      const err = res.reason;
      console.error(`down  ${zone}  ${err.code || err.message}`);
    }
  }

  process.exit(failed ? 1 : 0);
}

main();
