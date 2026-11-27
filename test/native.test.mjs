import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

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
      user_id: user,
      topic_id: topic,
      post_number: id,
      topic: { archetype: flags.archetype || "private_message" },
    };
    if (!posts.has(id)) posts.set(id, post);
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
      crypto: { base64Decode: (s) => Buffer.from(s, "base64").toString("latin1") },
    };
    const outcome = activeScript.runInNewContext(sandbox);
    if (outcome === "ignored") return null;
    if (outcome === "already handled") return outcome;
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
    assert.doesNotMatch(s.replies[0].raw, /z-lib\.gd|z-library\.website/);
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
    const selection = s.search().books[1].selection;
    const firstCalls = failedPath === loginPath ? [loginPath] : [loginPath, searchPath];
    assert.deepEqual(s.calls.map(c => [c.origin, c.path]), [
      ...firstCalls.map(path => [mirror, path]), [original, loginPath], [original, searchPath],
    ]);
    assert.equal(s.calls.at(-2).options.headers.Cookie, undefined);
    assert.equal(s.replies.length, 1);
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
  assert.equal(s.replies.length, 1);
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
    assert.equal(s.replies.length, 1);
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
  const selection = s.search().books[1].selection;
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
    const selection = s.search().books[1].selection;
    s.cfg.origins = [original, mirror];
    s.state.onRequest = ({ path }) => {
      if (path === failedPath) throw new Error("FinalDestination: lookup failed");
    };
    assert.equal(s.run("download", { selection }).error, "upstream");
    const paths = [loginPath, "/eapi/book/53/def/file", "/file/sample"];
    assert.deepEqual(s.calls.slice(2).map(c => [c.origin, c.path]),
      paths.slice(0, paths.indexOf(failedPath) + 1).map(path => [mirror, path]));
    assert.equal(s.replies.length, 2);
  }
});

test("replaying a handled post neither repeats a file request nor publishes another reply", () => {
  const s = site();
  s.cfg.origins = [mirror, original];
  const selection = s.search().books[1].selection;
  assert.equal(s.run("download", { selection }).delivery, "forum");
  const count = s.calls.length;
  assert.equal(s.run("download", { selection }, 2, 10, { existingPostId: 2 }), "already handled");
  assert.equal(s.calls.length, count);
  assert.equal(s.replies.length, 2);
  assert.equal(s.uploads.length, 1);
});

function contextualSearch({
  command = "这篇出自哪本书", title = "盐",
  raw = "A passage that must stay on the forum.\n\n作者：伊萨克·巴别尔 【1894-1940】\n\n译者： 戴骢",
  parent, replyTo, catalog = [], wikidata = [], publicSource = true, hidden = false, rejectLogin = false,
} = {}) {
  const topic = { id: 750, first_post_id: 82, title, archetype: "regular" };
  const first = { id: 82, topic_id: 750, topic, post_number: 1, post_type: 1, raw, hidden };
  const target = { id: 105, topic_id: 750, topic, post_number: 5, post_type: 1, raw: parent };
  const mention = { id: 108, topic_id: 750, topic, post_number: 6, post_type: 1, user_id: 17,
    reply_to_post_number: replyTo, raw: ("@ZlibBot " + command).trim() };
  const posts = new Map([first, target, mention].map(p => [p.id, p]));
  const requests = [], fields = new Map();
  let reply;
  const response = (data, status = 200) => ({ status, body: JSON.stringify(data) });
  const sandbox = {
    context: { post_id: 108, topic_id: 750, user_id: 17, feature_name: "ai_tool_action" },
    discourse: {
      baseUrl: "https://forum.example",
      getPost: id => posts.get(id),
      getTopic: id => id === 750 ? topic : null,
      getCustomField: (_kind, _id, key) => fields.get(key),
      setCustomField: (_kind, _id, key, value) => fields.set(key, value),
      createPost: p => { reply = p.raw; return { success: true }; },
    },
    secrets: { get: () => JSON.stringify({ origin: "https://books.example", email: "catalog@example.invalid", password: "not-public" }) },
    http: {
      get: (url, options) => {
        requests.push({ url, headers: options.headers });
        if (url.startsWith("https://query.wikidata.org/sparql?")) return response({ results: { bindings: wikidata } });
        if (publicSource && url === "https://forum.example/posts/by_number/750/1.json") return response(first);
        if (publicSource && parent && url === "https://forum.example/posts/by_number/750/5.json") return response(target);
        return response({}, 404);
      },
      post: (url, options) => {
        const params = new URLSearchParams(options.body);
        requests.push({ url, query: params.get("message"), page: params.get("page") });
        if (url.endsWith("/user/login")) return rejectLogin ? response({ success: 0 }, 401)
          : response({ success: 1, user: { id: 7, remix_userkey: "private-fixture-key" } });
        if (url.endsWith("/book/search")) return response({ success: 1, books: catalog.map((row, i) => ({
          id: i + 21, hash: "a" + i, ...row,
        })) });
        throw new Error("Unexpected request");
      },
    },
  };
  script.runInNewContext(sandbox);
  return { reply, fields, requests, searches: requests.filter(r => r.query) };
}

test("a bare mention and the original-post question resolve Salt to the collection and credit matching editions first", () => {
  const catalog = [
    { title: "军事史话与红色骑兵军", author: "巴别尔", extension: "epub" },
    { title: "骑兵军", author: "无关作者", extension: "epub" },
    { title: "骑兵军", author: "巴别尔", extension: "epub" },
    { title: "红色骑兵军", author: "伊萨克·巴别尔, 戴骢", extension: "pdf", year: 2012 },
    { title: "骑兵军", author: "巴别尔；孙越译", extension: "pdf", year: 1992 },
    { title: "研究报告：骑兵军", author: "巴别尔", extension: "epub" },
  ];
  for (const command of ["", "找一下原帖这本书", "请帮我找一下原帖这篇小说收在哪本书里，优先找原文标注译者的中文版。"]) {
    const s = contextualSearch({ command, catalog });
    assert.deepEqual(s.searches.map(r => r.query), ["骑兵军"]);
    assert.equal(s.requests.length, 2);
    assert.match(s.reply, /〈盐〉收在《骑兵军》/);
    assert.match(s.reply, /2004.*2003.*works_and_criticism/);
    assert.match(s.reply, /2012 · PDF[\s\S]+巴别尔 · EPUB[\s\S]+1992 · PDF/);
    assert.doesNotMatch(s.reply, /军事史话|无关作者|研究报告|zlibrary-edition|private-fixture/);
    assert.ok(!s.fields.has("book_library_editions_v1"));
  }
  const outage = contextualSearch({ rejectLogin: true });
  assert.match(outage.reply, /〈盐〉收在《骑兵军》/);
  assert.match(outage.reply, /account/);
});

test("source context stays tied to the selected public post; explicit titles, ISBNs and ambiguity are handled independently", () => {
  const s = contextualSearch({ replyTo: 5, parent: "作者：A. Author\n选自《Collected Letters》" });
  assert.equal(s.searches[0].query, "Collected Letters");
  assert.match(s.reply, /WorldCat|worldcat/);
  assert.doesNotMatch(s.reply, /骑兵军/);
  assert.deepEqual(s.requests[0].headers.Accept, "application/json");
  assert.equal(Object.keys(s.requests[0].headers).length, 1);
  const op = contextualSearch({ replyTo: 5, parent: "选自《Another book》", command: "请找原帖这篇的出处" });
  assert.equal(op.searches[0].query, "骑兵军");
  const explicit = contextualSearch({ command: "请帮我找一下《小王子》好吗？" });
  assert.equal(explicit.searches[0].query, "小王子");
  const isbn = contextualSearch({ title: "書目資料", raw: "ISBN：978-1-78227-093-5", command: "找一下原帖这本书" });
  assert.equal(isbn.searches[0].query, "9781782270935");
  for (const input of [
    { replyTo: 5, parent: "这两篇分别选自《甲》和《乙》。又有一篇选自《丙》。" },
    { replyTo: 5, parent: "引文", publicSource: false },
    { hidden: true },
    { command: "《另一篇》出自哪本书？" },
  ]) {
    const unresolved = contextualSearch(input);
    assert.match(unresolved.reply, /無法確定/);
    assert.equal(unresolved.searches.length, 0);
  }
});

function wikidataRow(workName, writerName, collection, collectionId = "Q459592") {
  const value = text => ({ value: text });
  const entity = id => value("http://www.wikidata.org/entity/" + id);
  return { work: entity("Q1216839"), creator: entity("Q6882"), collection: entity(collectionId), collectionLabel: value(collection),
    workName: value(workName), writerName: value(writerName) };
}

test("an uncatalogued story resolves via a single exact title/author and book relationship; inaccessible or conflicting evidence is rejected", () => {
  const title = "The Dead", author = "James Joyce", raw = "Sample narrative, withheld from public services.\nAuthor: James Joyce";
  const row = wikidataRow(title, author, "Dubliners");
  const found = contextualSearch({ title, raw, wikidata: [row] });
  assert.deepEqual(found.searches.map(r => r.query), ["Dubliners"]);
  assert.match(found.reply, /James Joyce的〈The Dead〉收在《Dubliners》/);
  assert.match(found.reply, /wikidata.org\/wiki\/Q1216839/);
  assert.ok(!found.fields.has("book_library_editions_v1"));
  const query = new URL(found.requests[1].url).searchParams.get("query");
  assert.match(query, /wdt:P50/);
  assert.match(query, /wdt:P361\|wdt:P1433/);
  assert.match(query, /wdt:P7937/);
  assert.doesNotMatch(query, /withheld|catalog@example|not-public/);
  assert.equal(found.requests.filter(r => r.url.startsWith("https://query.wikidata.org/")).length, 1);
  for (const wikidata of [[], [row, wikidataRow(title, author, "Other Collection", "Q999")],
    [wikidataRow(title, "Another Writer", "Dubliners")], [wikidataRow("Different story", author, "Dubliners")]]) {
    const miss = contextualSearch({ title, raw, wikidata });
    assert.equal(miss.searches.length, 0);
    assert.match(miss.reply, /無法確定/);
  }
  const restricted = contextualSearch({ title, raw, wikidata: [row], publicSource: false });
  assert.equal(restricted.requests.length, 1);
  assert.match(restricted.requests[0].url, /^https:\/\/forum\.example\//);
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

test("the original member's unmentioned nudge in 14538/4 retries the verified legacy book request and returns the original English EPUB", () => {
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
    assert.match(answer.raw, /standardebooks\.org\/ebooks\/jane-austen\/pride-and-prejudice\/downloads\/jane-austen_pride-and-prejudice\.epub/);
    assert.doesNotMatch(answer.raw, /A Retell/);
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
  assert.match(f.replies.at(-1).raw, new RegExp("#zlibrary-edition-" + otherMember.id + "\\.0-pdf"));
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
