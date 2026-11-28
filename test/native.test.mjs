import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";

const tool = JSON.parse(
  readFileSync(new URL("../native/forum-book-tool.json", import.meta.url)),
).ai_tool;
const script = new vm.Script(tool.script + "\ninvoke();");
const originsTool = JSON.parse(
  readFileSync(new URL("../native/forum-book-tool-origins.json", import.meta.url)),
).ai_tool;
const originsScript = new vm.Script(originsTool.script + "\ninvoke();");
test("both artifacts can be evaluated again inside the same Discourse tool context", () => {
  for (const definition of [tool, originsTool]) {
    const context = vm.createContext({});
    const source = new vm.Script(definition.script);
    source.runInContext(context);
    source.runInContext(context);
  }
});
const nonce = "cc6df8b2-3159-4c27-8ae8-189cf3628a03";
const pdf = Buffer.from("%PDF-1.4\nForum fixture\n%%EOF\n");
function site(activeScript = script) {
  const posts = new Map(),
    fields = new Map(),
    calls = [],
    replies = [],
    edits = [],
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
    const { origin, pathname: path } = new URL(url);
    const call = { origin, path, options, method };
    calls.push(call);
    const override = state.onRequest?.(call);
    if (override !== undefined) return override;
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
    const id = flags.existingPostId ?? posts.size + 1;
    const post = {
      id,
      raw: flags.raw ?? ("book-library-request-v1\n" + JSON.stringify({ op, nonce, ...input })),
      user_id: user, username: "reader" + user,
      topic_id: topic,
      post_number: flags.number || id,
      topic: { archetype: flags.archetype || "private_message" },
    };
    if (!posts.has(id) || flags.replace) posts.set(id, post);
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
        setCustomField: (_t, i, k, v) => {
          if (v.length > 1024) throw new Error("Value too long (max 1024 characters)");
          return fields.set(i + ":" + k, v);
        },
        editPost: (i, raw, options) => {
          assert.equal(i, id);
          assert.equal(options.username, post.username);
          edits.push({ id: i, raw });
          return { success: true, post_id: i };
        },
        createPost: (p) => {
          replies.push(p);
          return { success: true, post_id: 1000 + id };
        },
      },
      http: { get: (u, o) => api(u, o, "GET"), post: (u, o) => api(u, o, "POST") },
      secrets: {
        get(name) {
          if (name === "book_account") return JSON.stringify(cfg);
          if (name === "book_origins" && activeScript === originsScript) return state.originsCredential;
          throw new Error("Undeclared credential alias");
        },
      },
      upload: {
        create: (name, b64) => {
          uploads.push({ name, bytes: Buffer.from(b64, "base64") });
          return { short_url: "upload://abcd." + name.split(".").at(-1) };
        },
      },
      crypto: { randomBytes, hmacSha256: (k, s) => createHmac("sha256", k).update(s).digest("hex"), base64Decode: (s) => Buffer.from(s, "base64").toString("latin1"),
        sha256: s => createHash("sha256").update(s).digest("hex") },
    };
    const outcome = activeScript.runInNewContext(sandbox);
    if (outcome === "ignored") return null;
    if (outcome === "already handled") return outcome;
    if (flags.archetype === "regular") return replies.at(-1).raw;
    return JSON.parse(edits.at(-1).raw.match(/<!-- book-library-workspace-v2 (.+) -->$/)[1]).result;
  }
  const search = () => run("search", { query: "試讀本", extension: "pdf", page: 1 });
  return { run, search, state, calls, fields, replies, edits, uploads, cfg };
}
test("searches for a forum member in a private topic; handles filters, pagination and multiple editions", () => {
  const s = site(),
    result = s.search();
  assert.equal(result.books.length, 2);
  assert.equal(result.total_pages, 2);
  assert.equal(result.has_next, true);
  assert.deepEqual(
    result.books.map((b) => b.extension),
    ["pdf", "epub"],
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
  const selection = s.search().books[0].selection;
  const result = s.run("download", { selection });
  assert.equal(result.delivery, "forum");
  assert.equal(result.download_url, "/uploads/short-url/abcd.pdf");
  assert.equal(s.uploads[0].name, "試讀本.pdf");
  assert.deepEqual(s.uploads[0].bytes, pdf);
  assert.equal(s.calls[3].path, "/eapi/book/53/def/file");
  assert.match(s.edits.at(-1).raw, /\[Download\]\(upload:\/\/abcd.pdf\)/);
});
test("refuses a selection copied to another account or conversation", () => {
  const s = site(),
    key = s.search().books[0].selection;
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
  const key = s.search().books[0].selection,
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
  const key = s.search().books[0].selection;
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
    const key = s.search().books[0].selection;
    assert.ok(s.run("download", { selection: key }).error);
    assert.doesNotMatch(s.edits.at(-1).raw, /fixture-long-account-session-key/);
  }
  for (const size of [undefined, 20 * 1024 * 1024]) {
    const s = site();
    s.state.size = size;
    const key = s.search().books[0].selection;
    assert.equal(s.run("download", { selection: key }).delivery, "provider");
    assert.equal(s.uploads.length, 0);
  }
});

test("downloads a small protected same-origin file without publishing its account-bearing URL", () => {
  const s = site();
  s.state.link = "/file/sample?remix_userkey=fixture-long-account-session-key";
  const key = s.search().books[0].selection;
  const delivered = s.run("download", { selection: key });
  assert.equal(delivered.delivery, "forum");
  assert.doesNotMatch(JSON.stringify(delivered), /remix|fixture-long/);
});

test("a real mention lists distinct editions in provider order without resolving any download", () => {
  const s = site();
  const mention = (raw) => s.run(null, {}, 2, 90, { archetype: "regular", raw });
  assert.equal(mention("@AnotherBot 試讀本"), null);
  assert.equal(mention("> @ZlibBot 試讀本"), null);
  const reply = mention("@ZlibBot 搜尋 試讀本");
  assert.equal(s.replies.at(-1).username, "ZlibBot");
  assert.match(reply, /1910.*PDF[\s\S]+1900.*EPUB/);
  assert.match(reply, /#zlibrary-edition-3\.1-epub/);
  assert.doesNotMatch(reply, /test-password|fixture-long|downloadLink|https:\/\/books\.example/);
  assert.deepEqual(s.calls.map(c => c.path), ["/eapi/user/login", "/eapi/book/search"]);
  assert.equal(s.run("download", { selection: "3.0", source_topic_id: 90 }, 3, 10).error, "selection");
  assert.equal(s.run("download", { selection: "3.0", source_topic_id: 91 }, 2, 10).error, "selection");
  assert.equal(s.run("embed", { selection: "3.0", source_topic_id: 90 }, 2, 10).error, "selection");
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
  const book = s.run("embed", { selection: "1.1", source_topic_id: 99 }, 5, 10);
  assert.equal(book.short_url, "upload://abcd.epub");
  assert.deepEqual(s.uploads[0].bytes, s.state.file);
  const [login,fileLookup,transfer] = s.calls.slice(-3);
  assert.equal(login.path, "/v2/login");
  assert.equal(fileLookup.path, "/v2/book/12/abc");
  assert.equal(transfer.options.headers.Cookie, undefined);
  assert.equal(transfer.options.headers["remix-userkey"], undefined);
});

const mirror = "https://z-library.website";
const original = "https://z-lib.gd";
const loginPath = "/eapi/user/login";
const searchPath = "/eapi/book/search";

test("search follows the configured order and sends a session only to the host that issued it", () => {
  for (const origins of [[mirror, original], [original, mirror]]) {
    const s = site();
    s.cfg.origins = origins;
    assert.equal(s.search().books.length, 2);
    assert.deepEqual(s.calls.map(c => [c.origin, c.path]), [[origins[0], loginPath], [origins[0], searchPath]]);
    assert.equal(s.calls[0].options.headers.Cookie, undefined);
    assert.match(s.calls[1].options.headers.Cookie, /remix_userid=8/);
    assert.doesNotMatch(s.edits[0].raw, /z-lib\.gd|z-library\.website/);
  }
});

test("members can select one configured site in a PM for that search and keep it when paging", () => {
  for (const command of ["試讀本 --site 2 --page 4", "試讀本 --page 4 --site 2"]) {
    const s = site();
    s.cfg.origins = [original, mirror];
    const result = s.run("search", { query: command, page: 1 });
    assert.equal(result.query, "試讀本");
    assert.equal(result.site, 2);
    assert.deepEqual(s.calls.map(c => c.origin), [mirror, mirror]);
    const parameters = new URLSearchParams(s.calls[1].options.body);
    assert.equal(parameters.get("page"), "4");
    assert.equal(parameters.get("message"), "試讀本");
    s.run("search", { query: result.query, site: result.site, page: 5 });
    assert.deepEqual(s.calls.slice(-2).map(c => c.origin), [mirror, mirror]);
    assert.match(s.calls.at(-1).options.body, /page=5/);
  }
});

test("a public request can choose a site and the next-page command retains the site", () => {
  for (const suffix of ["--page 1 --site 2", "--site 2 --page 1"]) {
    const s = site();
    s.cfg.origins = [original, mirror];
    const reply = s.run(null, {}, 2, 10, { archetype: "regular", raw: "@ZlibBot 試讀本 " + suffix });
    assert.match(reply, /@ZlibBot 試讀本 --site 2 --page 2/);
    assert.deepEqual(s.calls.map(c => c.origin), [mirror, mirror]);
  }
});

test("an explicit source never falls back, and unavailable or malformed choices send no requests", () => {
  const s = site();
  s.cfg.origins = [original, mirror];
  for (const suffix of ["--site 0", "--site 3", "--site https://bad.example", "--site", "--site=1",
    "--site 1 --site 2", "--page 0 --site 1", "--page 1 --page 1"]) {
    assert.equal(s.run("search", { query: "試讀本 " + suffix, page: 1 }).error, "query");
    s.run(null, {}, 2, 10, { archetype: "regular", raw: "@ZlibBot 試讀本 " + suffix });
  }
  assert.equal(s.run("search", { query: "試讀本 --site 1", page: 1, site: 2 }).error, "query");
  assert.equal(s.run("search", { query: "試讀本", page: 1, site: "https://example.com" }).error, "query");
  assert.equal(s.calls.length, 0);
  s.state.onRequest = () => { throw new Error("FinalDestination: lookup failed"); };
  assert.equal(s.run("search", { query: "試讀本", page: 1, site: 2 }).error, "upstream");
  assert.deepEqual(s.calls.map(c => [c.origin, c.path]), [[mirror, loginPath]]);
});

test("administrators may configure up to three distinct supplier-listed hosts", () => {
  const s = site();
  s.cfg.origins = ["https://z-lib.sk", "https://z-library.sk", "https://z-lib.fm"];
  assert.equal(s.run("search", { query: "試讀本 --site 3", page: 1 }).books.length, 2);
  assert.deepEqual(s.calls.map(c => c.origin), ["https://z-lib.fm", "https://z-lib.fm"]);
  s.cfg.origins.push(mirror);
  assert.equal(s.search().error, "configuration");
  assert.equal(s.calls.length, 2);
});

test("search tries each host once after a DNS or TCP connect failure and pins the edition to its source", () => {
  for (const failedPath of [loginPath, searchPath]) {
    const s = site();
    s.cfg.origins = [mirror, original];
    s.state.onRequest = ({ origin, path }) => {
      if (origin === mirror && path === failedPath) throw new Error(
        failedPath === loginPath ? "FinalDestination: lookup failed" :
          "Failed to open TCP connection to z-library.website:443 (Connection timed out - connect(2))",
      );
    };
    const selection = s.search().books[0].selection;
    const firstCalls = failedPath === loginPath ? [loginPath] : [loginPath, searchPath];
    assert.deepEqual(s.calls.map(c => [c.origin, c.path]), [
      ...firstCalls.map(path => [mirror, path]), [original, loginPath], [original, searchPath],
    ]);
    assert.equal(s.calls.at(-2).options.headers.Cookie, undefined);
    assert.equal(s.edits.length, 1);
    assert.equal(s.replies.length, 0);
    assert.equal(s.run("download", { selection }).delivery, "forum");
    assert.deepEqual(s.calls.slice(-3).map(c => [c.origin, c.path]), [
      [original, loginPath], [original, "/eapi/book/53/def/file"], [original, "/file/sample"],
    ]);
    s.cfg.origins = [mirror];
    const count = s.calls.length;
    assert.equal(s.run("download", { selection }).error, "selection");
    assert.equal(s.calls.length, count);
  }
});

test("returns a single failure after exhausting the ordered hosts without extra rounds", () => {
  const s = site();
  s.cfg.origins = [original, mirror];
  s.state.onRequest = ({ origin }) => {
    if (origin === original) throw new Error(
      "Failed to open TCP connection to z-lib.gd|192.0.2.1.final-destination.invalid:443 (execution expired)",
    );
    throw new Error("connect ETIMEDOUT");
  };
  assert.equal(s.search().error, "upstream");
  assert.deepEqual(s.calls.map(c => [c.origin, c.path]), [[original, loginPath], [mirror, loginPath]]);
  assert.equal(s.edits.length, 1);
    assert.equal(s.replies.length, 0);
});

test("the extra binding overrides both account settings without exposing or rewriting the account", () => {
  assert.deepEqual(tool.secret_contracts, [{ alias: "book_account" }]);
  assert.deepEqual(originsTool.secret_contracts, [{ alias: "book_account" }, { alias: "book_origins" }]);
  const s = site(originsScript);
  s.cfg.origins = [original, mirror];
  s.state.originsCredential = JSON.stringify([mirror, original]);
  assert.equal(s.search().books.length, 2);
  assert.deepEqual(s.calls.map(c => c.origin), [mirror, mirror]);
  for (const raw of [undefined, "", "{}", "null", "[bad", '["https://unrelated.example"]']) {
    s.state.originsCredential = raw;
    assert.equal(s.search().error, "configuration");
    assert.equal(s.calls.length, 2);
  }
});

test("never switches hosts for an HTTP response, TLS error, read timeout, or blocked destination", () => {
  const responses = [
    [{ status: 401, body: '{"success":0}' }, "account"],
    [{ status: 403, body: "<html>captcha</html>" }, "verification"],
    [{ status: 307, body: "<html>verify</html>" }, "verification"],
    [{ status: 429, body: "Too many requests" }, "rate_limited"],
    [{ status: 429, body: '{"error":"daily download limit"}' }, "quota"],
    [{ status: 502, body: "Bad gateway" }, "upstream"],
    [new Error("SSL_connect: certificate verify failed"), "upstream"],
    [new Error("SSL_connect: certificate check: getaddrinfo ENOTFOUND"), "upstream"],
    [new Error("Net::ReadTimeout with #<TCPSocket>"), "upstream"],
    [new Error("execution expired"), "upstream"],
    [new Error("FinalDestination: all resolved IPs were disallowed"), "upstream"],
  ];
  for (const [response, expected] of responses) {
    const s = site();
    s.cfg.origins = [mirror, original];
    s.state.onRequest = () => {
      if (response instanceof Error) throw response;
      return response;
    };
    assert.equal(s.search().error, expected);
    assert.deepEqual(s.calls.map(c => [c.origin, c.path]), [[mirror, loginPath]]);
    assert.equal(s.edits.length, 1);
    assert.equal(s.replies.length, 0);
  }
});

test("an invalid ordered list sends no credentials, even with a valid legacy origin", () => {
  for (const origins of [
    [], mirror, null, [original, mirror, original], [mirror, mirror + "/"],
    [mirror, "https://books.example"], ["https://z-lib.gd.example"],
    ["http://z-lib.gd"], ["https://z-lib.gd/admin"], ["https://z-lib.gd:444"],
  ]) {
    const s = site();
    s.cfg.origin = original;
    s.cfg.origins = origins;
    assert.equal(s.search().error, "configuration");
    assert.equal(s.calls.length, 0);
  }
});

test("only single-origin installations can reuse a pre-upgrade selection with an unknown source", () => {
  const s = site();
  const selection = s.search().books[0].selection;
  const cacheKey = "1:book_library_editions_v1";
  const cached = JSON.parse(s.fields.get(cacheKey));
  delete cached.origin;
  s.fields.set(cacheKey, JSON.stringify(cached));
  assert.equal(s.run("download", { selection }).delivery, "forum");
  s.cfg.origins = [mirror, original];
  const count = s.calls.length;
  assert.equal(s.run("download", { selection }).error, "selection");
  assert.equal(s.calls.length, count);
});

test("file requests stay on their selected host and a failed issuance is never repeated", () => {
  for (const failedPath of [loginPath, "/eapi/book/53/def/file", "/file/sample"]) {
    const s = site();
    s.cfg.origins = [mirror, original];
    const selection = s.search().books[0].selection;
    s.cfg.origins = [original, mirror];
    s.state.onRequest = ({ path }) => {
      if (path === failedPath) throw new Error("FinalDestination: lookup failed");
    };
    assert.equal(s.run("download", { selection }).error, "upstream");
    const paths = [loginPath, "/eapi/book/53/def/file", "/file/sample"];
    assert.deepEqual(s.calls.slice(2).map(c => [c.origin, c.path]),
      paths.slice(0, paths.indexOf(failedPath) + 1).map(path => [mirror, path]));
    assert.equal(s.edits.length, 2);
    assert.equal(s.replies.length, 0);
  }
});

test("replaying a handled post neither repeats a file request nor publishes another reply", () => {
  const s = site();
  s.cfg.origins = [mirror, original];
  const selection = s.search().books[0].selection;
  assert.equal(s.run("download", { selection }).delivery, "forum");
  const count = s.calls.length;
  assert.equal(s.run("download", { selection }, 2, 10, { existingPostId: 2 }), "already handled");
  assert.equal(s.calls.length, count);
  assert.equal(s.edits.length, 2);
    assert.equal(s.replies.length, 0);
  assert.equal(s.uploads.length, 1);
});

function bookConversation() {
  const topic = { id: 14538, first_post_id: 255300, archetype: "regular" };
  function make(id, number, user, username, raw, parent) {
    return { id, post_number: number, post_type: 1, user_id: user, username, topic_id: topic.id, topic, raw, reply_to_post_number: parent };
  }
  const first = make(topic.first_post_id, 1, 1, "suen", "@ZlibBot Pride and Prejudice");
  const older = make(255318, 3, -1234, "ZlibBot", "書庫目前無法完成搜尋（upstream）。", 1);
  const nudge = make(255321, 4, 1, "suen", "你要相信自己：）", 3);
  const posts = new Map([first, older, nudge].map(post => [post.id, post]));
  const fields = new Map(), queries = [], replies = [];
  function create(text, parent, user = 1, username = "suen") {
    const last = [...posts.values()].at(-1);
    const post = make(last.id + 1, last.post_number + 1, user, username, text, parent.post_number);
    posts.set(post.id, post);
    return post;
  }
  const key = (kind, id, name) => [kind, id, name].join(":");
  const response = data => ({ status: 200, body: JSON.stringify(data) });
  const sandbox = vm.createContext({
    discourse: {
      baseUrl: "https://forum.example",
      getPost: id => posts.get(id), getTopic: id => id === topic.id && topic,
      getCustomField: (...parts) => fields.get(key(...parts)),
      setCustomField: (kind, id, name, value) => { fields.set(key(kind, id, name), value); return { success: true }; },
      createPost: payload => {
        const target = [...posts.values()].find(post => post.post_number === payload.reply_to_post_number);
        const reply = create(payload.raw, target, -1234, payload.username);
        replies.push(reply);
        return { success: true, post_id: reply.id, post_number: reply.post_number };
      },
    },
    secrets: { get: () => JSON.stringify({ origin: "https://books.example", email: "fiction@example.invalid", password: "fixture-only" }) },
    http: { get: () => { throw new Error("unexpected HTTP GET"); }, post: (url, options) => {
      if (url.endsWith("/user/login")) return response({ success: 1, user: { id: 9, remix_userkey: "fixture-login" } });
      assert.equal(url, "https://books.example/eapi/book/search");
      const form = new URLSearchParams(options.body);
      queries.push(Object.fromEntries(form));
      return response({ success: 1, books: [
        { id: 1, hash: "a", title: "Pride & Prejudice", author: "A Reteller", extension: "epub" },
        { id: 2, hash: "b", title: "Pride and Prejudice", author: "Austen, Jane", extension: form.get("extensions[]") || "epub", language: "English" },
        { id: 3, hash: "c", title: "A Retelling of Pride and Prejudice", author: "Jane Austen", extension: "epub" },
      ] });
    } },
  });
  new vm.Script(tool.script).runInContext(sandbox);
  const index = () => vm.runInContext("indexLegacyBookReply(255318, " + first.id + ")", sandbox);
  function run(post) {
    sandbox.context = { feature_name: "ai_tool_action", user_id: post.user_id, topic_id: post.topic_id, post_id: post.id };
    return vm.runInContext("invoke()", sandbox);
  }
  return { run, index, create, queries, replies, posts, first, older, nudge, fields };
}

test("the original member's unmentioned nudge in 14538/4 repeats the original keyword search and displays every returned edition", () => {
  for (const suppressReplyUser of [false, true]) {
    const forum = bookConversation();
    assert.equal(forum.index(), "indexed");
    assert.equal(forum.index(), "already indexed");
    if (!suppressReplyUser) forum.nudge.reply_to_user = { id: -1234, username: "ZlibBot" };
    assert.equal(forum.run(forum.nudge), "handled");
    assert.deepEqual(forum.queries.map(query => query.message), ["Pride and Prejudice"]);
    const answer = forum.replies.at(-1);
    assert.equal(answer.reply_to_post_number, 4);
    assert.match(answer.raw, /Austen, Jane/);
    assert.match(answer.raw, /#zlibrary-edition-255321\.0-epub/);
    assert.match(answer.raw, /A Reteller[\s\S]+Austen, Jane[\s\S]+A Retelling/);
    assert.doesNotMatch(answer.raw, /standardebooks|upload:\/\//);
    assert.equal(forum.run(forum.nudge), "already handled");
    assert.equal(forum.queries.length, 1);
    assert.equal(forum.replies.length, 1);
  }
});

test("replies retain their own thread's query and filters and a new title starts a new search", () => {
  const f = bookConversation();
  f.index();
  f.run(f.nudge);
  const answer = f.replies.at(-1);
  const otherMember = f.create("可以找 PDF 版嗎？", answer, 33, "another");
  f.run(otherMember);
  assert.equal(f.queries.at(-1).message, "Pride and Prejudice");
  assert.equal(f.queries.at(-1)["extensions[]"], "pdf");
  assert.match(f.replies.at(-1).raw, new RegExp("#zlibrary-edition-" + otherMember.id + "\\.1-pdf"));
  assert.doesNotMatch(f.replies.at(-1).raw, /standardebooks/);
  f.run(f.create("下一頁", f.replies.at(-1)));
  assert.equal(f.queries.at(-1).page, "2");
  assert.equal(f.queries.at(-1)["extensions[]"], "pdf");
  f.run(f.create("請找《Emma》", answer));
  assert.equal(f.queries.at(-1).message, "Emma");
  assert.equal(f.queries.at(-1)["extensions[]"], undefined);
  f.run(f.create("謝謝！", f.replies.at(-1)));
  assert.match(f.replies.at(-1).raw, /不客氣/);
  f.run(f.create("這是什麼意思？", answer));
  assert.match(f.replies.at(-1).raw, /Pride and Prejudice/);
  assert.equal(f.queries.length, 4);
});

test("unrelated replies, cross-topic IDs, hidden parents and the bot's posts do not trigger catalog lookups", () => {
  const f = bookConversation();
  f.index();
  assert.equal(f.run(f.create("《Emma》", f.first)), "ignored");
  const wrongRecipient = f.create("再試一次", f.older);
  wrongRecipient.reply_to_user = { id: 1, username: "suen" };
  assert.equal(f.run(wrongRecipient), "ignored");
  const self = f.create("@ZlibBot 《Emma》", f.older, 45, "ZlibBot");
  assert.equal(f.run(self), "ignored");
  assert.equal(f.run(f.older), "ignored");
  f.older.hidden = true;
  assert.equal(f.run(f.nudge), "ignored");
  f.older.hidden = false;
  f.older.topic_id++;
  assert.equal(f.run(f.nudge), "ignored");
  assert.equal(f.queries.length, 0);
  assert.equal(f.replies.length, 0);
});

test("page results keep the provider's exact order, duplicates, and rows without download IDs; only the reader's chosen row fetches a file", () => {
  const s = site();
  const keywords = "Water Clock";
  const base = { title:keywords, author:"Ellis, Casey", language:"English", filesize:310 };
  const pages = [
    [{ ...base, id:10, hash:"a", extension:"pdf" }, { ...base, id:11, hash:"b", author:"Another Writer", extension:"epub" },
      { ...base, id:10, hash:"a", extension:"pdf" }, { title:"Catalogue-only record", publisher:"Book Press" },
      { title:"Unrelated title", author:"Unrelated writer", id:14, hash:"e", extension:"mobi" }],
    Array.from({ length:12 }, (_, i) => ({ ...base, title: "Long edition title ".repeat(10) + i, id:20+i,
      hash:"ed"+i, extension:i===11 ? "pdf" : "epub" })),
  ];
  s.state.onRequest = ({path,options}) => {
    if (path === searchPath) {
      const params = new URLSearchParams(options.body);
      assert.equal(params.get("message"), keywords);
      assert.equal(params.get("limit"), "10");
      assert.deepEqual([...params.keys()].sort(), ["limit","message","page"]);
      const page=Number(params.get("page"));
      return {status:200,body:JSON.stringify({ success:1,books:pages[page-1],pagination:{current:page,total_pages:2} })};
    }
    if (path === "/eapi/book/31/ed11/file") return {status:200,body:JSON.stringify({ success:1,file:{downloadLink:"https://files.example/selected-edition.pdf"} })};
  };
  const a = s.run("search",{query:keywords,page:1});
  assert.deepEqual(a.books.map(b=>[b.title,b.author,b.extension]),pages[0].map(b=>[b.title,b.author||"",b.extension||""]));
  assert.equal(a.books[3].selection,null);
  assert.equal(a.books[4].selection,"1.4");
  assert.ok(a.has_next);
  const b = s.run("search",{query:keywords,page:2});
  assert.deepEqual(b.books.map(row=>row.title),pages[1].map(row=>row.title));
  assert.equal(b.page,2);
  assert.equal(b.total_pages,2);
  assert.equal(b.has_next,false);
  assert.equal(b.books[11].selection,"2.11");
  assert.equal(new Set(b.books.map(row=>row.row_key)).size,12);
  assert.ok([...s.fields.values()].every(value=>value.length<=1024));
  assert.equal(JSON.parse(s.fields.get("2:book_library_editions_v1")).count,12);
  assert.deepEqual(s.calls.map(c=>c.path),[loginPath,searchPath,loginPath,searchPath]);
  assert.equal(s.run("download",{selection:"1.3"}).error,"selection");
  assert.equal(s.run("download",{selection:"2.11"},4).error,"selection");
  assert.equal(s.run("download",{selection:"2.11"}).download_url,"https://files.example/selected-edition.pdf");
  assert.deepEqual(s.calls.map(c=>c.path),[loginPath,searchPath,loginPath,searchPath,loginPath,"/eapi/book/31/ed11/file"]);
  assert.equal(s.uploads.length,0);
});

test("a public reply renders unselectable metadata and a later downloadable row at its original position", () => {
  const s=site();
  s.state.onRequest=({path})=>path===searchPath ? {status:200,body:JSON.stringify({success:1,books:[
    { title:"Report only", href:"https://unrelated.example/book/18/aaaa" },
    { title:"", author:"Author without a title" },
    { title:"Recovered by provider reference", href:"https://books.example/book/88/hash88/title", extension:"pdf" },
    { title:"Final listing", id:"20",hash:"ccc",extension:"epub" },
  ],pagination:{current:0,total_pages:3}})} : undefined;
  const text=s.run(null,{},2,90,{archetype:"regular",raw:"@ZlibBot any keywords --page 2"});
  assert.match(text,/第 2 頁，共 3 頁/);
  assert.match(text,/1\. Report only（未提供下載識別碼）/);
  assert.match(text,/2\. 未提供書名 · Author without a title/);
  assert.match(text,/3\. \[Recovered by provider reference · PDF\].*1\.2-pdf/);
  assert.match(text,/4\. \[Final listing · EPUB\].*1\.3-epub/);
  assert.match(text,/--page 1/);
  assert.match(text,/--page 3/);
  assert.deepEqual(s.calls.map(c=>c.path),[loginPath,searchPath]);
});

test("an empty provider page stays empty and its declared next page remains reachable", () => {
  const s=site();
  s.state.onRequest=({path})=>path===searchPath ? {status:200,body:JSON.stringify({success:1,books:[],pagination:{current:1,total_pages:2}})} : undefined;
  const reply=s.run(null,{},2,90,{archetype:"regular",raw:"@ZlibBot literal --ext epub"});
  assert.match(reply,/沒有傳回「literal」/);
  assert.match(reply,/@ZlibBot literal --ext epub --page 2/);
  assert.doesNotMatch(reply,/zlibrary-edition/);
  assert.deepEqual(s.calls.map(c=>c.path),[loginPath,searchPath]);
});

test("a reader reuses one silent workspace and an earlier edition survives a subsequent search", () => {
  const s = site();
  let sequence = 0;
  function submit(op, fields) {
    const packet = { kind: "request", nonce: nonce.slice(0,-4) + String(++sequence).padStart(4, "0"), op, ...fields };
    const raw = "Book library workspace.\n\n<!-- book-library-workspace-v2 " + JSON.stringify(packet) + " -->";
    return s.run(op, fields, 2, 10, { existingPostId: 1, replace: true, number: 1, raw });
  }
  const key = submit("search", { query: "first", page: 1 }).books[0].selection;
  submit("search", { query: "second", page: 1 });
  assert.equal(submit("download", { selection: key }).delivery, "forum");
  assert.equal(submit("download", { selection: key + "x" }).error, "selection");
  assert.equal(s.replies.length, 0);
  assert.ok(s.edits.every(edit => edit.id === 1));
});
