import test from "node:test";
import assert from "node:assert/strict";
import { BookService } from "../service/books.mjs";
import { fixture, forum, pdf } from "./fixture.mjs";

test("searches editions, submits filters and pagination, retains only forum session cookies for membership", async () => {
  const f = fixture();
  const r = await f.request("search", { query: "試讀本", page: 2, extension: "pdf" });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Cache-Control"), /no-store/);
  const data = await r.json();
  assert.deepEqual(
    data.books.map((x) => x.extension),
    ["epub", "pdf"],
  );
  assert.equal(data.has_next, true);
  assert.equal(data.total_pages, 2);
  assert.doesNotMatch(
    JSON.stringify(data),
    /upstream-test-key|only-a-fixture|cdn\.example|test@example/,
  );
  assert.equal(f.calls[0].options.headers.Cookie, "_t=member");
  const q = f.calls.at(-1).options;
  assert.deepEqual(Object.fromEntries(q.body), {
    message: "試讀本",
    page: "2",
    limit: "20",
    "extensions[]": "pdf",
  });
  assert.equal(q.headers["remix-userkey"], "upstream-test-key");
  assert.doesNotMatch(q.headers.Cookie, /_t=member/);
});
test("returns the exact selected file with Unicode name and no credential on the CDN", async () => {
  const f = fixture();
  const data = await f.search();
  assert.equal(
    f.calls.some((x) => x.u.pathname.endsWith("/file")),
    false,
  );
  const r = await f.request("download", { selection: data.books[1].selection });
  assert.equal(r.status, 200);
  assert.match(
    r.headers.get("Content-Disposition"),
    /filename\*=UTF-8''%E8%A9%A6%E8%AE%80%E6%9C%AC\.pdf/,
  );
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), pdf);
  assert.equal(f.calls.at(-2).u.pathname, "/eapi/book/53/def/file");
  assert.equal(f.calls.at(-1).options.headers.Cookie, undefined);
});
test("requires the forum member, the public site origin, and a same-origin UI request", async () => {
  for (const headers of [
    { Cookie: "" },
    { Origin: "https://else.example" },
    { "X-Zlibrary-Request": "" },
  ]) {
    const f = fixture();
    assert.equal((await f.request("search", { query: "book" }, headers)).status, 403);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.state.member = async () => Response.json({});
  assert.equal((await f.request("search", { query: "book" })).status, 403);
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.api.fetch(new Request(forum + "/z-library-api/search"), f.env)).status,
    405,
  );
  assert.equal(
    (await f.api.fetch(new Request("https://another.example/z-library-api/search"), f.env)).status,
    404,
  );
});
test("rejects an expired, tampered, or different member's selection before any file request", async () => {
  const f = fixture();
  const s = (await f.search()).books[1].selection;
  for (const [token, headers] of [
    [s + "a", {}],
    [s, { Cookie: "_t=other" }],
  ]) {
    assert.equal((await f.request("download", { selection: token }, headers)).status, 422);
  }
  const original = Date.now;
  try {
    Date.now = () => original() + 21 * 60000;
    assert.equal((await f.request("download", { selection: s })).status, 422);
  } finally {
    Date.now = original;
  }
  assert.equal(
    f.calls.some((x) => x.u.pathname.endsWith("/file")),
    false,
  );
});
test("invalid input and absent bindings do not spend the service account quota", async () => {
  const f = fixture();
  for (const body of [
    { query: "" },
    { query: "a", page: -1 },
    { query: "b", extension: "exe" },
    { query: "x".repeat(12500) },
  ]) {
    assert.equal((await f.request("search", body)).status, 422);
  }
  f.env.SEARCH_LIMIT = { limit: async () => ({ success: false }) };
  assert.equal((await f.request("search", { query: "valid" })).status, 429);
  delete f.env.SEARCH_LIMIT;
  assert.equal((await f.request("search", { query: "valid" })).status, 503);
  assert.equal(
    f.calls.every((x) => x.u.origin === forum),
    true,
  );
});
test("renews a rejected provider session once, and passes on quota and challenges", async () => {
  const f = fixture();
  await f.search();
  f.responses.push(() => Response.json({ success: 0, error: "please login" }, { status: 401 }));
  assert.equal((await f.search()).books.length, 2);
  assert.equal(f.calls.filter((x) => x.u.pathname.endsWith("/login")).length, 2);
  const s = (await f.search()).books[1].selection;
  for (const [res, code] of [
    [Response.json({ success: 0, error: "daily download limit" }, { status: 429 }), "quota"],
    [
      new Response("<html>Verify</html>", { headers: { "Content-Type": "text/html" } }),
      "verification",
    ],
  ]) {
    f.responses.push(() => res);
    const out = await f.request("download", { selection: s });
    assert.equal((await out.json()).error, code);
  }
});
test("rejects undisclosed hosts and cross-origin redirects without following them", async () => {
  const f = fixture();
  const s = (await f.search()).books[1].selection;
  for (const link of [
    "http://cdn.example/x",
    "https://outside.example/x",
    "https://name:pass@cdn.example/x",
  ]) {
    f.responses.push(() => Response.json({ success: 1, file: { downloadLink: link } }));
    assert.equal((await (await f.request("download", { selection: s })).json()).error, "file_host");
  }
  f.responses.push(
    () => Response.json({ success: 1, downloadLink: "https://books.example/book" }),
    () => Response.redirect("https://outside.example/x"),
  );
  assert.equal((await (await f.request("download", { selection: s })).json()).error, "file_host");
  assert.equal(
    f.calls.some((x) => x.u.hostname === "outside.example"),
    false,
  );
});
test("checks limits, truncated files and split HTML before offering an attachment", async () => {
  const f = fixture();
  const s = (await f.search()).books[1].selection;
  const split = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("<ht"));
      c.enqueue(new TextEncoder().encode("ml>Login"));
      c.close();
    },
  });
  for (const [r, code] of [
    [new Response(pdf, { headers: { "Content-Length": String(26 * 1024 * 1024) } }), "too_large"],
    [new Response(pdf, { headers: { "Content-Length": "100" } }), "incomplete"],
    [new Response(split), "verification"],
  ]) {
    f.responses.push(
      () => Response.json({ success: 1, downloadLink: "https://cdn.example/book" }),
      () => r,
    );
    const out = await f.request("download", { selection: s, hub: true });
    assert.equal((await out.json()).error, code);
    assert.equal(out.headers.get("Content-Disposition"), null);
  }
});
test("stream aborts a later transfer that exceeds the declared size", async () => {
  const f = fixture();
  const s = (await f.search()).books[1].selection;
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(300));
      c.enqueue(new Uint8Array(100));
      c.close();
    },
  });
  f.responses.push(
    () => Response.json({ success: 1, downloadLink: "https://cdn.example/book" }),
    () => new Response(stream, { headers: { "Content-Length": "320" } }),
  );
  await assert.rejects((await f.request("download", { selection: s })).arrayBuffer(), /incomplete/);
});
test("suppresses invalid records, handles empty pages, and checks configured origins", async () => {
  const f = fixture();
  await f.search();
  f.responses.push(() =>
    Response.json({ success: 1, books: [{ id: 4, hash: "../", title: "bad" }] }),
  );
  assert.deepEqual((await f.search()).books, []);
  assert.throws(
    () =>
      new BookService({ ...f.env, ZLIBRARY_ORIGIN: "http://book.example" }, fetch, new WeakMap()),
    /configuration/,
  );
});
