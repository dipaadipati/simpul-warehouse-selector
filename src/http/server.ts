/**
 * The HTTP layer: thin on purpose. It validates input at the trust boundary,
 * calls the domain, and serialises the answer. No selection logic lives here,
 * so the interesting behaviour is testable without a running server.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  COLD_CHAIN_POLICIES,
  DEFAULT_POLICY,
  describeCatalog,
  isColdChainPolicy,
  selectWarehouses,
  travelObjectiveAvailable,
  validateOrder,
} from "../domain/select.ts";
import type { Objective } from "../domain/select.ts";
import { DAYS } from "../bonus/history.ts";
import { isDepartureTime } from "../bonus/travel.ts";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "..", "public");

/** Small enough that a stray large body cannot tie up the process. */
const MAX_BODY_BYTES = 64 * 1024;

/** The health check's whole body, kept here so its length is not a second literal. */
const HEALTH = "ok";

/** The fields the order endpoint reads. Anything else is a typo, not a hint. */
const ORDER_FIELDS = ["items", "policy", "objective", "departAt"];

/**
 * Which methods each path answers. Consulted only by the fallback, so that a path
 * that exists under another method answers 405 instead of 404: the caller has
 * the URL right and the verb wrong, and "no route" sends them looking for a
 * missing endpoint rather than reading the one line that would fix it.
 *
 * HEAD is listed wherever GET is, because RFC 9110 9.3.2 says a server that
 * serves GET serves HEAD. Uptime monitors reach for HEAD first, and the one
 * endpoint they are most likely to point at is /healthz.
 */
const METHODS: Record<string, readonly string[]> = {
  "/healthz": ["GET", "HEAD"],
  "/api/catalog": ["GET", "HEAD"],
  "/api/orders": ["POST"],
  "/": ["GET", "HEAD"],
  "/index.html": ["GET", "HEAD"],
};

const json = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleOrder(req: IncomingMessage, res: ServerResponse) {
  let parsed: unknown;
  try {
    const raw = await readBody(req);
    if (raw.trim() === "") {
      json(res, 400, { error: "empty request body; send {\"items\":[{\"productId\":\"P001\",\"quantity\":10}]}" });
      return;
    }
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, 400, { error: `could not read request body: ${message}` });
    return;
  }

  if (typeof parsed !== "object" || parsed === null) {
    json(res, 400, { error: "body must be a JSON object" });
    return;
  }

  // Refused rather than ignored. A caller who writes {"day": "Mon"} at the top
  // level gets an answer identical to one who sent nothing, and no way to tell
  // the difference from the outside: the field looks accepted because the
  // request succeeded. That is a slow way to find a typo.
  const unknown = Object.keys(parsed).filter((key) => !ORDER_FIELDS.includes(key));
  if (unknown.length > 0) {
    json(res, 400, {
      error: `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; this endpoint reads ${ORDER_FIELDS.join(", ")}`,
    });
    return;
  }

  const { items, policy, objective, departAt } = parsed as {
    items?: unknown;
    policy?: unknown;
    objective?: unknown;
    departAt?: unknown;
  };

  const problems = validateOrder(items);
  if (problems.length > 0) {
    json(res, 400, { error: "invalid order", problems });
    return;
  }
  if (policy !== undefined && !isColdChainPolicy(policy)) {
    json(res, 400, { error: `policy must be one of ${COLD_CHAIN_POLICIES.join(", ")}` });
    return;
  }
  if (objective !== undefined && objective !== "distance" && objective !== "minutes") {
    json(res, 400, { error: 'objective must be "distance" or "minutes"' });
    return;
  }
  if (departAt !== undefined && !isDepartureTime(departAt)) {
    json(res, 400, {
      error: `departAt must be {day, hour} with day one of ${DAYS.join(", ")} and hour a whole number 0-23`,
    });
    return;
  }
  // Better a plain 400 than the RangeError from the domain, which the catch-all
  // below would report as a server fault.
  if (objective === "minutes" && !travelObjectiveAvailable()) {
    json(res, 400, {
      error: 'the "minutes" objective needs the historical delivery log, which is not deployed here; use "distance"',
    });
    return;
  }

  // A decision, even "we cannot fulfil this", is a successful answer with an
  // explanation attached, so it goes back as 200 with feasible:false.
  json(
    res,
    200,
    selectWarehouses(items as { productId: string; quantity: number }[], policy ?? DEFAULT_POLICY, {
      objective: objective as Objective | undefined,
      departAt,
    }),
  );
}

async function handlePage(res: ServerResponse) {
  try {
    const html = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.length });
    res.end(html);
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("public/index.html is missing");
  }
}

export function createApp() {
  return createServer(async (req, res) => {
    // The pathname is compared against literal route strings and never joined
    // onto a filesystem path, so it is used as-is. Running it through
    // path.normalize would be both pointless and wrong: on Windows it rewrites
    // "/healthz" to "\healthz" and every route stops matching.
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    try {
      // HEAD is answered as GET and Node drops the body on the way out, which is
      // what the spec asks for: same headers, no payload.
      const reads = req.method === "GET" || req.method === "HEAD";

      if (reads && path === "/healthz") {
        // The length is stated rather than left to Node, which would otherwise
        // frame this one with chunked encoding on GET and with nothing at all on
        // HEAD, where there is no body to chunk. Stating it makes the two header
        // sets identical, which is what a HEAD is supposed to return.
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": Buffer.byteLength(HEALTH),
        });
        res.end(HEALTH);
        return;
      }
      if (reads && path === "/api/catalog") {
        json(res, 200, {
          ...describeCatalog(),
          policies: COLD_CHAIN_POLICIES,
          defaultPolicy: DEFAULT_POLICY,
          objectives: ["distance", "minutes"],
          travelObjectiveAvailable: travelObjectiveAvailable(),
          days: DAYS,
        });
        return;
      }
      if (req.method === "POST" && path === "/api/orders") {
        await handleOrder(req, res);
        return;
      }
      if (reads && (path === "/" || path === "/index.html")) {
        await handlePage(res);
        return;
      }
      const allowed = METHODS[path];
      if (allowed) {
        // Allow is what turns a 405 from "no" into "no, and here is the verb you
        // want", which is the whole reason this branch is not a 404.
        json(res, 405, { error: `use ${allowed.join(" or ")} for ${path}` }, { allow: allowed.join(", ") });
        return;
      }
      json(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: message });
    }
  });
}

// No "am I the entrypoint?" guard here, deliberately. PM2 loads this file
// through its own ProcessContainerFork, so process.argv[1] names that container
// and not this file - a guard comparing the two starts nothing at all, and the
// process sits there online with no listener and an empty log. The first
// version of this file had that guard and deployed exactly that way.
//
// createApp stays exported for anything that wants the request handler without
// the listener.
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
createApp().listen(port, host, () => {
  console.log(`warehouse selector listening on http://${host}:${port}`);
});
