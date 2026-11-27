// Run by the browser spec. The book provider is a fixture; Discourse verifies its own login.
import { readFileSync } from "node:fs";
import { fixture } from "./fixture.mjs";
const input = JSON.parse(readFileSync(0, "utf8"));
const base = new URL(input.forumServer);
if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
  throw new Error("Test forum must be a loopback server");
}
const f = fixture();
f.state.member = ({ headers }) =>
  fetch(new URL("/session/current.json", base), { headers, redirect: "manual" });
const result = await f.request(input.operation, input.body, { Cookie: input.cookie });
console.log(
  JSON.stringify({
    status: result.status,
    headers: Object.fromEntries(result.headers),
    body: Buffer.from(await result.arrayBuffer()).toString("base64"),
    filePath: f.calls.find((x) => x.u.pathname.endsWith("/file"))?.u.pathname || null,
  }),
);
