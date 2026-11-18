#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const profile = process.env.DSH_PROFILE?.trim() || process.argv[2] || "web";
const tag = process.env.DSH_BUNDLE_TAG?.trim() || "v1.0.9";
const rawBase = process.env.DSH_BUNDLE_BASE_URL?.trim() || ("https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/" + tag);
const base = rawBase.replace(/\/+$/, "");
const markdownVersion = process.env.DSH_MD_VERSION?.trim() || "0.1.4";
const localeVersion = process.env.DSH_LOCALE_VERSION?.trim() || "0.1.4";
const localeRef = process.env.DSH_LOCALE_REF?.trim() || "";
const packages = [
  "github:kuraneko1/dsh-mobile-maxxing#" + tag,
  base + `/dsh-md-rendering-${markdownVersion}.tgz`,
  localeRef !== ""
    ? "github:kuraneko1/dsh-locale-ja#" + localeRef
    : base + `/dsh-locale-ja-${localeVersion}.tgz`,
];

const command = process.platform === "win32" ? "dsh.cmd" : "dsh";
const result = spawnSync(command, ["plugin", "--profile", profile, "add", ...packages], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
