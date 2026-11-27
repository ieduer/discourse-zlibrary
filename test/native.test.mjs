import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const tool = JSON.parse(
  readFileSync(new URL("../native/forum-book-tool.json", import.meta.url)),
).ai_tool;
const script = new vm.Script(tool.script + "\ninvoke();");
const nonce = "cc6df8b2-3159-4c27-8ae8-189cf3628a03";
const pdf = Buffer.from("%PDF-1.4\nForum fixture\n%%EOF\n");
function site() {
  const posts = new Map(),
    fields = new Map(),
    calls = [],
    replies = [],
    uploads = [];
  const state = {
    login: true,
    link: "/file/sample",
    size: pdf.length,
    file: pdf,
    fileStatus: 200,
    quota: false,
  };
  const cfg = {
    origin: "https://books.example",
    email: "test@example.invalid",
    password: "test-password",
  };
  function api(url, options, method) {
    const path = new URL(url).pathname;
    calls.push({ path, options, method });
    const result = (body, status = 200) => ({ status, body: JSON.stringify(body) });
    if (path === (cfg.login_path || "/eapi/user/login"))
      return state.login
        ? result({ success: 1, user: { id: 8, remix_userkey: "fixture-long-account-session-key" } })
        : result({ success: 0 }, 401);
    if (path === (cfg.search_path || "/eapi/book/search"))
      return result({
        success: 1,
        pagination: { total_pages: 2, current: 1 },
        books: [
          {
            id: 53,
            hash: "def",
            title: "試讀本",
            year: 1910,
            extension: "pdf",
            filesize: state.size,
          },
          { id: 12, hash: "abc", title: "試讀本", year: 1900, extension: "epub", filesize: state.size },
        ],
      });
    if (path === "/eapi/book/53/def/file" || path === "/eapi/book/12/abc/file" || path === "/v2/book/12/abc")
      return state.quota
        ? result({ success: 0, error: "daily download limit" }, 429)
        : result({ success: 1, file: { downloadLink: state.link } });
    if (path === "/file/sample")
      return { status: state.fileStatus, body: state.file.toString("base64") };
    throw new Error("Unexpected fixture request");
  }
  function run(op, input, user = 2, topic = 10, flags = {}) {
    const id = posts.size + 1;
    const post = {
      id,
      raw: flags.raw ?? ("book-library-request-v1\n" + JSON.stringify({ op, nonce, ...input })),
      user_id: user,
      topic_id: topic,
      post_number: id,
      topic: { archetype: flags.archetype || "private_message" },
    };
    posts.set(id, post);
    const sandbox = {
      context: {
        user_id: user,
        post_id: id,
        topic_id: topic,
        feature_name: flags.feature || "ai_tool_action",
      },
      discourse: {
        baseUrl: "https://forum.example",
        getPost: (i) => posts.get(i),
        getCustomField: (_t, i, k) => fields.get(i + ":" + k),
        setCustomField: (_t, i, k, v) => fields.set(i + ":" + k, v),
        createPost: (p) => {
          replies.push(p);
          return { success: true, post_id: 1000 + id };
        },
      },
      http: { get: (u, o) => api(u, o, "GET"), post: (u, o) => api(u, o, "POST") },
      secrets: { get: (name) => (name === "book_account" ? JSON.stringify(cfg) : null) },
      upload: {
        create: (name, b64) => {
          uploads.push({ name, bytes: Buffer.from(b64, "base64") });
          return { short_url: "upload://abcd." + name.split(".").at(-1) };
        },
      },
      crypto: { base64Decode: (s) => Buffer.from(s, "base64").toString("latin1") },
    };
    const outcome = script.runInNewContext(sandbox);
    if (outcome === "ignored") return null;
    if (flags.archetype === "regular") return replies.at(-1).raw;
    return JSON.parse(replies.at(-1).raw.split("\n")[3]).result;
  }
  const search = () => run("search", { query: "試讀本", extension: "pdf", page: 1 });
  return { run, search, state, calls, fields, replies, uploads, cfg };
}
test("searches for a forum member in a private topic; handles filters, pagination and multiple editions", () => {
  const s = site(),
    result = s.search();
  assert.equal(result.books.length, 2);
  assert.equal(result.total_pages, 2);
  assert.equal(result.has_next, true);
  assert.deepEqual(
    result.books.map((b) => b.extension),
    ["epub", "pdf"],
  );
  assert.match(s.calls[1].options.body, /extensions%5B%5D=pdf/);
  assert.equal(s.calls.length, 2);
  assert.doesNotMatch(
    JSON.stringify(result),
    /fixture-long|test-password|test@example|downloadLink|"hash"/,
  );
});
test("selects the correct edition, and the private forum attachment preserves its exact bytes", () => {
  const s = site();
  const selection = s.search().books[1].selection;
  const result = s.run("download", { selection });
  assert.equal(result.delivery, "forum");
  assert.equal(result.download_url, "/uploads/short-url/abcd.pdf");
  assert.equal(s.uploads[0].name, "試讀本.pdf");
  assert.deepEqual(s.uploads[0].bytes, pdf);
  assert.equal(s.calls[3].path, "/eapi/book/53/def/file");
  assert.match(s.replies.at(-1).raw, /\[Download\]\(upload:\/\/abcd.pdf\)/);
});
test("refuses a selection copied to another account or conversation", () => {
  const s = site(),
    key = s.search().books[1].selection;
  assert.equal(s.run("download", { selection: key }, 4, 10).error, "selection");
  assert.equal(s.run("download", { selection: key }, 2, 20).error, "selection");
  assert.equal(s.calls.length, 2);
});
test("skips regular topics, unrelated features, unauthenticated contexts and bad commands", () => {
  const s = site();
  assert.equal(s.run("search", { query: "abc", page: 1 }, 2, 10, { archetype: "regular" }), null);
  assert.equal(s.run("search", { query: "abc", page: 1 }, 2, 10, { feature: "ai_bot" }), null);
  assert.equal(s.run("search", { query: "abc", page: 1 }, -1), null);
  assert.equal(s.run("invalid", {}), null);
  assert.equal(s.calls.length, 0);
  assert.equal(s.run("search", { query: "", page: 1 }).error, "query");
});
test("returns the CDN file URL without sending it the forum book account", () => {
  const s = site();
  s.state.link = "https://files.example/download/per-file-token";
  const key = s.search().books[1].selection,
    res = s.run("download", { selection: key });
  assert.equal(res.download_url, s.state.link);
  assert.equal(res.delivery, "provider");
  assert.equal(s.calls.length, 4);
  assert.equal(s.uploads.length, 0);
});
test("stops on login rejection, quota and incomplete book bytes", () => {
  const s = site();
  s.state.login = false;
  assert.equal(s.search().error, "account");
  s.state.login = true;
  const key = s.search().books[1].selection;
  s.state.quota = true;
  assert.equal(s.run("download", { selection: key }).error, "quota");
  s.state.quota = false;
  s.state.file = Buffer.from("too short");
  assert.equal(s.run("download", { selection: key }).error, "incomplete");
  assert.equal(s.uploads.length, 0);
});
test("never publishes a credential in a file URL or copies an unknown or oversized file to the forum", () => {
  for (const link of [
    "https://files.example/x?remix_userkey=abc",
    "https://files.example/fixture-long-account-session-key",
    "https://user:password@files.example/book",
  ]) {
    const s = site();
    s.state.link = link;
    const key = s.search().books[1].selection;
    assert.ok(s.run("download", { selection: key }).error);
    assert.doesNotMatch(s.replies.at(-1).raw, /fixture-long-account-session-key/);
  }
  for (const size of [undefined, 20 * 1024 * 1024]) {
    const s = site();
    s.state.size = size;
    const key = s.search().books[1].selection;
    assert.equal(s.run("download", { selection: key }).delivery, "provider");
    assert.equal(s.uploads.length, 0);
  }
});

test("downloads a small protected same-origin file without publishing its account-bearing URL", () => {
  const s = site();
  s.state.link = "/file/sample?remix_userkey=fixture-long-account-session-key";
  const key = s.search().books[1].selection;
  const delivered = s.run("download", { selection: key });
  assert.equal(delivered.delivery, "forum");
  assert.doesNotMatch(JSON.stringify(delivered), /remix|fixture-long/);
});

test("a real mention lists distinct editions EPUB first without resolving any download", () => {
  const s = site();
  const mention = (raw) => s.run(null, {}, 2, 90, { archetype: "regular", raw });
  assert.equal(mention("@AnotherBot 試讀本"), null);
  assert.equal(mention("> @ZlibBot 試讀本"), null);
  const reply = mention("@ZlibBot 搜尋 試讀本");
  assert.equal(s.replies.at(-1).username, "ZlibBot");
  assert.match(reply, /1900.*EPUB[\s\S]+1910.*PDF/);
  assert.match(reply, /#zlibrary-edition-3\.0-epub/);
  assert.doesNotMatch(reply, /test-password|fixture-long|downloadLink|https:\/\/books\.example/);
  assert.deepEqual(s.calls.map(c => c.path), ["/eapi/user/login", "/eapi/book/search"]);
  assert.equal(s.run("download", { selection: "3.0", source_topic_id: 90 }, 3, 10).error, "selection");
  assert.equal(s.run("download", { selection: "3.0", source_topic_id: 91 }, 2, 10).error, "selection");
  assert.equal(s.run("embed", { selection: "3.1", source_topic_id: 90 }, 2, 10).error, "selection");
  assert.equal(s.calls.length, 2);
});

test("only the confirmed EPUB is fetched and cross-domain delivery never receives the shared login", () => {
  const s = site();
  s.state.file = Buffer.from("PK\x03\x04book fixture", "latin1");
  s.state.size = s.state.file.length;
  s.state.link = "https://files.example/file/sample";
  s.cfg.bot_username = "BookScout";
  s.cfg.login_path = "/v2/login";
  s.cfg.search_path = "/v2/search";
  s.cfg.file_path = "/v2/book/{id}/{hash}";
  s.run(null, {}, 5, 99, {archetype: "regular", raw: "@BookScout 試讀本 --page 2"});
  assert.match(s.calls[1].options.body, /page=2/);
  const book = s.run("embed", { selection: "1.0", source_topic_id: 99 }, 5, 10);
  assert.equal(book.short_url, "upload://abcd.epub");
  assert.deepEqual(s.uploads[0].bytes, s.state.file);
  const [login,fileLookup,transfer] = s.calls.slice(-3);
  assert.equal(login.path, "/v2/login");
  assert.equal(fileLookup.path, "/v2/book/12/abc");
  assert.equal(transfer.options.headers.Cookie, undefined);
  assert.equal(transfer.options.headers["remix-userkey"], undefined);
});
