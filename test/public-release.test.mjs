import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const files = await Promise.all([
  readFile(new URL("web/index.html", root), "utf8"),
  readFile(new URL("web/src/main.jsx", root), "utf8"),
  readFile(new URL("README.md", root), "utf8"),
  readFile(new URL("render.yaml", root), "utf8"),
  readFile(new URL("src/server.mjs", root), "utf8"),
]);
const [html, app, readme, render, server] = files;

test("public brand, metadata, and primary action describe one RetryCredit release", () => {
  assert.match(html, /<title>RetryCredit \| The retry pays for the failure<\/title>/);
  assert.match(html, /https:\/\/retrycredit\.dolepee\.com\/retrycredit-og-v1\.png/);
  assert.match(html, /https:\/\/github\.com\/dolepee\/retrycredit/);
  assert.doesNotMatch(html, /github\.com\/dolepee\/ruledrop/);
  assert.doesNotMatch(html, /RuleDrop/);
  assert.match(app, /Finish the swap/);
  assert.match(app, /YOUR RECOVERY/);
  assert.match(app, /Connect wallet to start/);
  assert.match(app, /hexlify\(toUtf8Bytes\(challenge\.message\)\)/);
  assert.match(app, /How this recovery is verified/);
  assert.match(app, /Restart saved run/);
  assert.match(app, /session && <button className="secondary"/);
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
    "0x9cb81e134e33f32b702786589510948d097ae98d0ef3ffec4c631a1288a0ee07",
    "0x81e96116c5b3e050a1b4ac6d1cea611817e7d028636003e7aa6d12f5c412f9b0",
    "0xb787581b58bab15bc4e8e78389c6d0d4bb362896d265bdbe2263df7d7eb77cdf",
  ];
  for (const hash of hashes) {
    assert.match(app, new RegExp(hash));
    assert.match(readme, new RegExp(hash));
  }
  assert.match(readme, /founder-funded service credit/);
  assert.match(readme, /not independent adoption or customer demand/);
  assert.match(app, /From stale route to credit in 552 seconds/);
  assert.match(app, /0\.218500 test USDC/);
  assert.match(app, /Creditcoin · 0\.01 tCTC/);
  assert.match(readme, /reviewed V3 pilot/);
  assert.match(readme, /V3 pilot is enabled/);
});

test("deployment configuration enables only the reviewed funded V3 pool", () => {
  assert.match(render, /RETRYCREDIT_PUBLIC_ENABLED\n\s+value: "true"/);
  assert.match(render, /RETRYCREDIT_DEMO_PRIVATE_KEY\n\s+sync: false/);
  assert.match(render, /0x81b5d955F4EbfaE02FF6346cf368A2c4347248A1/);
  assert.match(render, /0x97Fa88CfCaeE1a5D4Ae749b9b5698F2147b986fC/);
  assert.match(server, /0x81b5d955F4EbfaE02FF6346cf368A2c4347248A1/);
  assert.match(server, /0x97Fa88CfCaeE1a5D4Ae749b9b5698F2147b986fC/);
  assert.match(render, /https:\/\/retrycredit\.dolepee\.com/);
});
