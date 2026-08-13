import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { RuleDropWorker, WorkerError, createEthereumProviders } from "./proof-worker.mjs";
import { poolAbi } from "./pool-abi.mjs";

const POOL_ADDRESS = process.env.RULEDROP_POOL_ADDRESS ?? "0x6f8dE7e1599A0c8D38eB25996cB841a4920ed999";
const CREDITCOIN_RPC = process.env.CREDITCOIN_RPC ?? "https://rpc.cc3-testnet.creditcoin.network";
const PROOF_BUILDER_URL = process.env.ATTESTCOIN_PROOF_BUILDER ?? "https://prover.cc3-testnet.creditcoin.network";
const PORT = Number(process.env.PORT ?? 4179);
const HOST = process.env.HOST ?? "127.0.0.1";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";
const ethereumRpcUrls = (process.env.ETHEREUM_RPC_URLS ?? "").split(",").map((value) => value.trim());
const staticRoot = fileURLToPath(new URL("../dist", import.meta.url));

const worker = new RuleDropWorker({
  poolAddress: POOL_ADDRESS,
  poolAbi,
  creditcoinRpc: CREDITCOIN_RPC,
  proofBuilderUrl: PROOF_BUILDER_URL,
  ethereumProviders: createEthereumProviders(ethereumRpcUrls),
});

createServer(async (request, response) => {
  const requestId = crypto.randomUUID();
  try {
    setHeaders(response, requestId);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "ruledrop-worker", network: 102031 });
      return;
    }

    const campaignMatch = url.pathname.match(/^\/api\/campaigns\/(\d+)$/);
    if (request.method === "GET" && campaignMatch) {
      const campaign = await worker.getCampaign(campaignMatch[1], url.searchParams.get("claimant"));
      sendJson(response, 200, campaign);
      return;
    }

    const claimMatch = url.pathname.match(/^\/api\/campaigns\/(\d+)\/prepare-claim$/);
    if (request.method === "POST" && claimMatch) {
      const body = await readJson(request);
      const prepared = await worker.prepareClaim({ campaignId: claimMatch[1], ...body });
      sendJson(response, 200, prepared);
      return;
    }

    if (request.method === "GET") {
      await sendStatic(response, url.pathname);
      return;
    }

    throw new WorkerError("NOT_FOUND", "Route not found", 404);
  } catch (error) {
    const handled = error instanceof WorkerError
      ? error
      : new WorkerError("INTERNAL_ERROR", "The worker could not process this request", 500, error);
    sendJson(response, handled.status, { error: { code: handled.code, message: handled.message, requestId } });
  }
}).listen(PORT, HOST, () => {
  console.log(`RuleDrop worker listening on http://${HOST}:${PORT}`);
});

function setHeaders(response, requestId) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("access-control-allow-origin", ALLOWED_ORIGIN);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("x-request-id", requestId);
  response.setHeader("x-content-type-options", "nosniff");
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new WorkerError("BODY_TOO_LARGE", "Request body exceeds 16 KB", 413);
  }
  try {
    return JSON.parse(body || "{}");
  } catch (error) {
    throw new WorkerError("INVALID_JSON", "Request body must be valid JSON", 400, error);
  }
}

function sendJson(response, status, body) {
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

async function sendStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : normalize(pathname).replace(/^[/\\]+/, "");
  if (requested.startsWith("..")) throw new WorkerError("NOT_FOUND", "Route not found", 404);
  let body;
  let file = join(staticRoot, requested);
  try {
    body = await readFile(file);
  } catch {
    file = join(staticRoot, "index.html");
    body = await readFile(file);
  }
  response.setHeader("content-type", mimeType(extname(file)));
  response.setHeader("cache-control", file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable");
  response.writeHead(200);
  response.end(body);
}

function mimeType(extension) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" })[extension]
    ?? "application/octet-stream";
}
