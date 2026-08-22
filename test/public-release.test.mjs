import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const files = await Promise.all([
  readFile(new URL("web/index.html", root), "utf8"),
  readFile(new URL("web/src/main.jsx", root), "utf8"),
  readFile(new URL("README.md", root), "utf8"),
  readFile(new URL("render.yaml", root), "utf8"),
]);
const [html, app, readme, render] = files;

test("public brand, metadata, and primary action describe one RetryCredit release", () => {
  assert.match(html, /<title>RetryCredit \| The retry pays for the failure<\/title>/);
  assert.match(html, /https:\/\/retrycredit\.dolepee\.com\/retrycredit-og-v1\.png/);
  assert.match(html, /https:\/\/github\.com\/dolepee\/retrycredit/);
  assert.doesNotMatch(html, /github\.com\/dolepee\/ruledrop/);
  assert.doesNotMatch(html, /RuleDrop/);
  assert.match(app, /Finish the swap/);
  assert.match(app, /YOUR RECOVERY/);
  assert.match(app, /Connect wallet to start/);
  assert.match(app, /How this recovery is verified/);
  assert.doesNotMatch(app, /href="#proof"/);
  assert.doesNotMatch(app, />Proof</);
  assert.doesNotMatch(app, /PUBLIC PRIMARY ACTION/);
  assert.match(app, /no mainnet asset or token approval/i);
  assert.match(app, /!session && config\?\.enabled !== true/);
  assert.match(app, /Checking availability/);
  assert.match(app, /Temporarily unavailable/);
  assert.match(app, /RetryCredit is temporarily unavailable\. Please try again shortly\./);
  assert.match(app, /verifies receipt state and settlement, not the human-readable reason a route failed/);
});

test("public evidence links bind the exact fresh lifecycle", () => {
  const hashes = [
    "0x5ef2e6e47da2892774967c69aa48814d4db08141d76e53418ad7886d67683722",
    "0xb6f516f52d0286bf274ae63a000df67583250c13d3645e6ce5e80ae40716766b",
    "0xbc44875c384fa4a9a67a7cdfd390d2322db84570c60e54fe65fed1e0b7a40e84",
  ];
  for (const hash of hashes) {
    assert.match(app, new RegExp(hash));
    assert.match(readme, new RegExp(hash));
  }
  assert.match(readme, /founder-funded service credits/);
  assert.match(readme, /not customer demand/);
});

test("deployment configuration is fail-closed and pins the funded pool", () => {
  assert.match(render, /RETRYCREDIT_PUBLIC_ENABLED\n\s+value: "false"/);
  assert.match(render, /RETRYCREDIT_DEMO_PRIVATE_KEY\n\s+sync: false/);
  assert.match(render, /0x9f29325134D48602B09647B16220Ef8Af350692A/);
  assert.match(render, /0xc89e4d598b2c62f48eeBaB371B1B7f4B459325BA/);
  assert.match(render, /https:\/\/retrycredit\.dolepee\.com/);
});
