"use strict";

const fs = require("node:fs");
const path = require("node:path");

function stubGlob() {
  return function glob(startPath, recursive, extension) {
    const wantRecursive = recursive !== false;
    const root = path.resolve(startPath);
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (wantRecursive) walk(full);
          continue;
        }
        if (!wantRecursive && path.resolve(path.dirname(full)) !== root) continue;
        if (extension && extension !== "*" && path.extname(full) !== extension) continue;
        files.push(full);
      }
    };
    walk(startPath);
    return files.sort();
  };
}

/**
 * @param {string} registryDir directory holding domains/ and dnsconfig.js
 * @returns {{zones: Object<string, Array<Array>>, error: (string|null)}}
 */
function runDnsconfig(registryDir) {
  const zones = {};
  const errors = [];
  const saved = {};
  const names = [
    "NewRegistrar", "DnsProvider", "NewDnsProvider", "A", "AAAA", "CNAME",
    "TXT", "MX", "NS", "SRV", "CAA", "PTR", "D", "glob",
  ];

  const g = globalThis;
  for (const name of names) saved[name] = Object.getOwnPropertyDescriptor(g, name);

  g.NewRegistrar = () => ({});
  g.DnsProvider = () => ({});
  g.NewDnsProvider = () => ({});
  g.A = (name, value, meta) => ["A", name, value, meta];
  g.AAAA = (name, value, meta) => ["AAAA", name, value, meta];
  g.CNAME = (name, value, meta) => ["CNAME", name, value, meta];
  g.TXT = (name, value) => ["TXT", name, value];
  g.MX = (name, priority, target) => ["MX", name, priority, target];
  g.NS = (name, target) => ["NS", name, target];
  g.SRV = (name, priority, weight, port, target) => ["SRV", name, priority, weight, port, target];
  g.CAA = (name, flag, tag, value) => ["CAA", name, flag, tag, value];
  g.PTR = (name, target) => ["PTR", name, target];
  g.D = (zone, registrar, provider, records) => {
    zones[String(zone).toLowerCase()] = records;
  };
  g.glob = stubGlob();

  const previousCwd = process.cwd();
  const target = path.join(registryDir, "dnsconfig.js");
  try {
    process.chdir(registryDir);
    delete require.cache[require.resolve(target)];
    require(target);
  } catch (error) {
    errors.push(error.message);
  } finally {
    process.chdir(previousCwd);
    for (const name of names) {
      if (saved[name]) Object.defineProperty(g, name, saved[name]);
      else delete g[name];
    }
    delete require.cache[require.resolve(target)];
  }

  return { zones, error: errors.length > 0 ? errors[0] : null };
}

module.exports = { runDnsconfig, stubGlob };
