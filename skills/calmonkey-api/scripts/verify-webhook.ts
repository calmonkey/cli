// A receiver for CalMonkey's webhook notifications that checks every request before it trusts
// it: the signature, the age of the signature, and whether the delivery was seen before.
//
//   CALMONKEY_CHANNEL_SIGNING_SECRET  the channel's signing_secret (whsec_...), returned once
//                                     by POST /v1/channels                          (required)
//   CALMONKEY_CLIENT_SECRET           your client secret: when set, Calmonkey-HMAC-SHA256
//                                     is checked as well
//   PORT                              default 4011
//
// It listens on http://localhost:4011/webhooks/calmonkey. For a test-mode application,
// register that address as the channel's callback_url and run `calmonkey listen`, which
// brings the notifications to this machine with the headers CalMonkey made.
//
// No dependencies. Run it with `npx tsx verify-webhook.ts` (Node 20 or later), or with
// `node verify-webhook.ts` on Node 22.18 or later.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const PATH = "/webhooks/calmonkey";
const TOLERANCE_SECONDS = 300;

const same = (a: string, b: string): boolean => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Calmonkey-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">, keyed with
 * the channel's signing secret. An old timestamp is refused, so a recorded request cannot be
 * sent again later.
 */
export function verifySignature(raw: Buffer, header: string | undefined, signingSecret: string, now: number = Date.now()): boolean {
  if (!header) return false;
  const parts = new Map(header.split(",").map((part) => part.trim().split("=", 2) as [string, string]));
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isInteger(t) || !v1) return false;
  if (Math.abs(now / 1000 - t) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", signingSecret).update(`${t}.`).update(raw).digest("hex");
  return same(v1, expected);
}

/**
 * Calmonkey-HMAC-SHA256: base64 HMAC-SHA256 of the raw body, keyed with your client secret.
 * While a rotated secret is still valid the header has one value per secret, separated by
 * commas: one match is enough. (Applications in compatibility mode also get the same value
 * under a second header name.)
 */
export function verifyHmac(raw: Buffer, header: string | undefined, clientSecret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", clientSecret).update(raw).digest("base64");
  return header.split(",").some((value) => same(value.trim(), expected));
}

type Notification = {
  notification: { type: "verification" | "change" | "profile_disconnected" | "profile_initial_sync_completed"; changes_since?: string };
  channel: { channel_id: string; callback_url: string; filters: Record<string, unknown> };
};

// Delivery is at least once: every attempt of one notification has the same
// Calmonkey-Delivery-Id. Keep the ids you have handled (in your database, in real code).
const handled = new Set<string>();

function handle({ notification, channel }: Notification): void {
  // Answer first and do the work in your own queue: CalMonkey waits 5 seconds for the answer.
  // On "change", read what changed since `changes_since` (GET /v1/events?last_modified=...),
  // or read free/busy again. On "profile_disconnected" the person has to connect again.
  console.log(`  ${notification.type} on ${channel.channel_id}${notification.changes_since ? `, changes since ${notification.changes_since}` : ""}`);
}

function main(): void {
  const signingSecret = process.env.CALMONKEY_CHANNEL_SIGNING_SECRET;
  const clientSecret = process.env.CALMONKEY_CLIENT_SECRET;
  if (!signingSecret) throw new Error("Set CALMONKEY_CHANNEL_SIGNING_SECRET to the channel's signing_secret.");
  const port = Number(process.env.PORT ?? 4011);

  const server = createServer((req, res) => {
    const answer = (status: number, why: string) => {
      console.log(`${req.method} ${req.url} -> ${status} ${why}`);
      res.writeHead(status).end();
    };
    if (req.method !== "POST" || req.url?.split("?")[0] !== PATH) return answer(404, "not the webhook path");

    // The signature is over the bytes as they arrived: parsing the JSON and writing it out
    // again would not give the same bytes.
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const header = (name: string) => [req.headers[name]].flat()[0];

      if (!verifySignature(raw, header("calmonkey-signature"), signingSecret)) return answer(401, "Calmonkey-Signature does not match, or is older than 5 minutes");
      if (clientSecret && !verifyHmac(raw, header("calmonkey-hmac-sha256"), clientSecret)) return answer(401, "Calmonkey-HMAC-SHA256 does not match");

      const deliveryId = header("calmonkey-delivery-id") ?? "";
      if (deliveryId && handled.has(deliveryId)) return answer(200, `already handled ${deliveryId}`);
      if (deliveryId) handled.add(deliveryId);

      // Any 2xx means delivered. Anything else is sent again for about 23 hours; 410 closes the channel.
      answer(200, `verified ${deliveryId} (attempt ${header("calmonkey-delivery-attempt") ?? "1"})`);
      handle(JSON.parse(raw.toString("utf8")) as Notification);
    });
  });
  server.listen(port, () => console.log(`Listening on http://localhost:${port}${PATH}`));
}

// Only when run as a program, so the two checks above can be imported as they are.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
