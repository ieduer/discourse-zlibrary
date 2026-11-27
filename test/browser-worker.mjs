// Run by the browser spec. The book provider is a fixture; Discourse verifies its own login.
import { readFileSync } from "node:fs";
import { fixture } from "./fixture.mjs";
const input = JSON.parse(readFileSync(0, "utf8"));
const base = new URL(input.forumServer);
if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
  throw new Error("Test forum must be a loopback server");
}
// Chromium maps test.localhost to the Puma IPv4 port. Node must use the same routing and Host.
base.hostname = "127.0.0.1";
const f = fixture();
const membership = [];
f.state.member = async ({ headers }) => {
  try {
    const res = await fetch(new URL("/session/current.json", base), {
      headers: { ...headers, Host: input.forumHost },
      redirect: "manual",
    });
    membership.push({ status: res.status });
    return res;
  } catch (error) {
    membership.push({ network: error.cause?.code || error.name });
    throw error;
  }
};
const result = await f.request(input.operation, input.body, { Cookie: input.cookie });
console.log(
  JSON.stringify({
    status: result.status,
    membership,
    headers: Object.fromEntries(result.headers),
    body: Buffer.from(await result.arrayBuffer()).toString("base64"),
    filePath: f.calls.find((x) => x.u.pathname.endsWith("/file"))?.u.pathname || null,
  }),
);
