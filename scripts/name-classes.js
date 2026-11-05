"use strict";

const PRONOUN_PARADIGM = {
  i: ["i", "me", "my", "mine", "myself"],
  we: ["we", "us", "our", "ours", "ourselves"],
  you: ["you", "your", "yours", "yourself", "yourselves", "yall", "yall"],
  he: ["he", "him", "his", "himself"],
  she: ["she", "her", "hers", "herself"],
  it: ["it", "its", "itself"],
  they: ["they", "them", "their", "theirs", "themselves", "themself"],
  who: ["who", "whom", "whose"],
  one: ["oneself"],
  id: ["aku", "saya", "gue", "gua", "gw", "kamu", "kau", "lu", "lo", "anda", "dia", "ia", "kita", "kami", "kalian", "mereka", "akoe", "engkau", "beliau", "diriku", "dirimu", "dirinya", "kita", "nyah"],
  indefinite: [
    "anyone", "everyone", "someone", "nobody", "everybody", "anybody", "somebody",
    "nothing", "everything", "anything", "something", "none",
  ],
};

const DETERMINERS = [
  "a", "an", "the", "this", "that", "these", "those", "some", "any", "no", "every",
  "each", "both", "either", "neither", "all", "more", "most", "few", "many", "much",
  "several", "enough", "another", "other", "others", "such", "what", "which", "whatever",
  "whichever", "either", "half", "whole", "own", "same",
];

const FUNCTION_WORDS = [
  "and", "or", "but", "if", "then", "than", "so", "because", "as", "of", "to", "in",
  "on", "at", "by", "with", "from", "for", "about", "into", "onto", "over", "under",
  "above", "below", "between", "again", "further", "once", "here", "there", "when",
  "where", "why", "how", "not", "only", "just", "very", "too", "also", "yes", "off",
  "out", "up", "down", "via", "per", "nor", "yet", "upon", "while", "during", "without",
];

const GENERIC_NOUNS = [
  "home", "site", "sites", "website", "web", "page", "pages", "blog", "shop", "store",
  "app", "apps", "application", "docs", "doc", "help", "support", "info", "about",
  "contact", "news", "main", "index", "portal", "hub", "link", "links", "url", "urls",
  "dns", "ip", "host", "hostname", "server", "servers", "cloud", "node", "edge", "proxy",
  "demo", "sample", "example", "temp", "tmp", "foo", "bar", "baz", "hello", "world",
  "user", "users", "guest", "signin", "signup", "register", "profile", "dashboard",
  "panel", "console", "files", "file", "img", "images", "image", "media", "video",
  "videos", "music", "public", "private", "secret", "key", "keys", "token", "tokens",
  "oauth", "sso", "pay", "payment", "payments", "invoice", "cart", "checkout", "order",
  "orders", "wallet", "crypto", "nft", "dao", "swap", "mint", "airdrop", "claim",
  "reward", "rewards", "earn", "money", "cash", "bank", "finance", "trade", "market",
  "exchange", "defi", "web3", "coin", "coins", "mine", "mining", "stake", "staking",
  "pool", "farm", "vip", "pro", "premium", "plus", "free", "new", "old", "top", "best",
  "first", "last", "zero", "null", "nil", "undefined", "true", "false", "nan", "local",
  "intranet", "lan", "wlan", "gateway", "router", "switch", "firewall", "nas", "ssh",
  "sftp", "pop", "pop3", "mx", "ns", "soa", "txt", "cname", "aaaa", "ptr", "srv", "caa",
  "zone", "registry", "system", "sys", "core", "base", "data", "db", "cache", "queue",
  "worker", "workers", "job", "jobs", "cron", "hook", "hooks", "webhook", "event",
  "events", "log", "logs", "metric", "metrics", "health", "ping", "trace", "debug",
];

const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t", "8": "b", "9": "g", "@": "a", "$": "s", "!": "i", "+": "t" };

const CLASSES = [
  { name: "pronoun", label: "a pronoun", why: "a pronoun points at whoever reads it, not at a person", words: Object.values(PRONOUN_PARADIGM).flat() },
  { name: "determiner", label: "a determiner", why: "a determiner only makes sense in front of another word", words: DETERMINERS },
  { name: "function-word", label: "a grammar word", why: "grammar words carry no identity", words: FUNCTION_WORDS },
  { name: "generic-noun", label: "a generic word", why: "generic words are shared vocabulary, not a personal handle", words: GENERIC_NOUNS },
];

const CLASS_BY_NAME = new Map(CLASSES.map((c) => [c.name, c]));

const KNOWN = new Map();
for (const cls of CLASSES) {
  for (const word of cls.words) {
    if (!KNOWN.has(word)) KNOWN.set(word, cls);
  }
}

function normalizeLabel(label) {
  const lowered = String(label).toLowerCase();
  const stripped = lowered.replace(/[-_.\s]/g, "");
  const leetless = stripped.replace(/[013456789@$!+]/g, (ch) => LEET[ch] || ch);
  return leetless.replace(/(.)\1{2,}/g, "$1");
}

function classifyLabel(label, enabledClasses) {
  const enabled = enabledClasses === undefined ? new Set(CLASS_BY_NAME.keys()) : new Set(enabledClasses);
  if (enabled.size === 0) return null;
  const candidates = new Set([String(label).toLowerCase(), normalizeLabel(label)]);
  for (const candidate of candidates) {
    const cls = KNOWN.get(candidate);
    if (cls && enabled.has(cls.name)) return cls;
  }
  for (const candidate of candidates) {
    if (/^[a-z]+$/.test(candidate) && candidate.length <= 3 && !/\d/.test(candidate)) {
      const valued = KNOWN.get(candidate);
      if (valued && enabled.has(valued.name)) return valued;
    }
  }
  return null;
}

module.exports = { classifyLabel, normalizeLabel, CLASSES, CLASS_BY_NAME, PRONOUN_PARADIGM };
