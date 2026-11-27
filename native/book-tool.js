// Discourse AI Tool Action entry point. All provider requests run in the forum's server-side tool runtime.
function invoke() {
  const requestMark = "book-library-request-v1";
  const resultMark = "book-library-result-v1";
  const cacheKey = "book_library_editions_v1";
  const receiptKey = "book_library_reply_v1";
  if (context.feature_name !== "ai_tool_action" || !(context.user_id > 0) || !context.post_id)
    return "ignored";
  const post = discourse.getPost(context.post_id);
  if (
    !post ||
    post.topic_id !== context.topic_id ||
    post.user_id !== context.user_id ||
    post.topic.archetype !== "private_message" ||
    !post.raw.startsWith(requestMark + "\n")
  )
    return "ignored";
  let request;
  try {
    request = JSON.parse(post.raw.slice(requestMark.length + 1));
  } catch (_) {
    return "ignored";
  }
  if (
    !request ||
    !/^[a-f0-9-]{36}$/.test(request.nonce) ||
    !["search", "download"].includes(request.op)
  )
    return "ignored";
  if (discourse.getCustomField("post", post.id, receiptKey)) return "already handled";

  function fail(code) {
    throw new Error(code);
  }
  function text(value, max) {
    return typeof value === "number" || typeof value === "string"
      ? String(value)
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .trim()
          .slice(0, max || 260)
      : "";
  }
  function endpoint(value) {
    const match =
      typeof value === "string" && value.match(/^https:\/\/([a-z0-9.-]+)(?::443)?\/?$/i);
    if (
      !match ||
      !match[1].includes(".") ||
      /(?:^|\.)localhost$|\.local$|\.internal$|^[0-9.]+$/i.test(match[1])
    )
      fail("configuration");
    return "https://" + match[1].toLowerCase();
  }
  function credentials() {
    let cfg;
    try {
      cfg = JSON.parse(secrets.get("book_account"));
    } catch (_) {
      fail("configuration");
    }
    if (
      !cfg ||
      typeof cfg.email !== "string" ||
      typeof cfg.password !== "string" ||
      !cfg.email.trim() ||
      !cfg.password
    )
      fail("configuration");
    return { origin: endpoint(cfg.origin), email: cfg.email.trim(), password: cfg.password };
  }
  function api(cfg, path, params, session) {
    const headers = { Accept: "application/json", source: "android" };
    if (session) {
      headers["remix-userid"] = session.id;
      headers["remix-userkey"] = session.key;
      headers.Cookie = session.cookie;
    }
    let response;
    if (params) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const body = Object.keys(params)
        .map((key) => encodeURIComponent(key) + "=" + encodeURIComponent(params[key]))
        .join("&");
      response = http.post(cfg.origin + path, { headers, body });
    } else {
      response = http.get(cfg.origin + path, { headers });
    }
    if (!response || typeof response.body !== "string" || response.body.length > 2000000)
      fail("upstream");
    let data;
    try {
      data = JSON.parse(response.body.replace(/^\uFEFF/, ""));
    } catch (_) {
      fail(response.status === 403 || /^\s*</.test(response.body) ? "verification" : "upstream");
    }
    if (response.status >= 200 && response.status < 300 && String(data.success) === "1")
      return data;
    const message = String(data.error || "").toLowerCase();
    if (/quota|daily.{0,35}limit|download.{0,35}limit|limit.{0,35}download/.test(message))
      fail("quota");
    if (response.status === 429) fail("rate_limited");
    if (response.status === 403 || /captcha|challenge|verification/.test(message))
      fail("verification");
    if (response.status === 404) fail("unavailable");
    if (response.status === 401 || !session) fail("account");
    fail("upstream");
  }
  function login(cfg) {
    const user = api(cfg, "/eapi/user/login", { email: cfg.email, password: cfg.password }).user;
    const key = user && (user.remix_userkey || user.remix_user_key);
    if (
      !user ||
      !/^\d{1,32}$/.test(String(user.id)) ||
      typeof key !== "string" ||
      !/^[a-zA-Z0-9._~%+=/-]{1,512}$/.test(key)
    )
      fail("account");
    return {
      id: String(user.id),
      key,
      cookie: "remix_userid=" + user.id + "; remix_userkey=" + key,
    };
  }
  function record(row) {
    if (
      !row ||
      !["string", "number"].includes(typeof row.id) ||
      !/^[\w-]{1,128}$/.test(String(row.id)) ||
      typeof row.hash !== "string" ||
      !/^[\w-]{1,128}$/.test(row.hash) ||
      !text(row.title)
    )
      return null;
    const extension = text(row.extension, 12).toLowerCase();
    const bytes = Number(row.filesize);
    return {
      id: String(row.id),
      hash: row.hash,
      title: text(row.title),
      author: text(row.author),
      publisher: text(row.publisher),
      year: text(row.year, 12),
      language: text(row.language, 64),
      extension: /^[a-z0-9]{1,12}$/.test(extension) ? extension : "",
      size: text(row.filesizeString, 50) || (bytes > 0 ? bytes + " B" : ""),
      bytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null,
    };
  }
  function search() {
    const q = request.query;
    const page = request.page;
    const extension = request.extension || "";
    if (
      typeof q !== "string" ||
      !q.trim() ||
      q.trim().length > 200 ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 999999 ||
      !["", "epub", "pdf", "mobi", "azw3", "djvu", "fb2", "txt"].includes(extension)
    )
      fail("query");
    const cfg = credentials();
    const form = { message: q.trim(), page: String(page), limit: "10" };
    if (extension) form["extensions[]"] = extension;
    const data = api(cfg, "/eapi/book/search", form, login(cfg));
    if (!Array.isArray(data.books)) fail("upstream");
    const rows = data.books.slice(0, 10).map(record).filter(Boolean);
    discourse.setCustomField(
      "post",
      post.id,
      cacheKey,
      JSON.stringify({ expiry: Date.now() + 1200000, rows }),
    );
    const current = Number(data.pagination && data.pagination.current) || page;
    const total = Number(data.pagination && data.pagination.total_pages) || null;
    return {
      books: rows.map((row, i) => {
        const copy = Object.assign({}, row);
        delete copy.id;
        delete copy.hash;
        copy.selection = post.id + "." + i;
        return copy;
      }),
      page: current,
      total_pages: total,
      has_next: total ? current < total : data.books.length >= 10,
    };
  }
  function download() {
    const m =
      typeof request.selection === "string" && request.selection.match(/^(\d{1,15})\.([0-9])$/);
    if (!m) fail("selection");
    const src = discourse.getPost(Number(m[1]));
    if (!src || src.user_id !== context.user_id || src.topic_id !== post.topic_id)
      fail("selection");
    const saved = discourse.getCustomField("post", src.id, cacheKey);
    if (!saved) fail("selection");
    const data = JSON.parse(saved);
    const book = data.rows[Number(m[2])];
    if (!book || data.expiry <= Date.now()) fail("selection");
    const cfg = credentials();
    const session = login(cfg);
    const info = api(cfg, "/eapi/book/" + book.id + "/" + book.hash + "/file", null, session);
    let url = (info.file && info.file.downloadLink) || info.downloadLink || info.url || info.link;
    if (typeof url !== "string" || !url || url.length > 8192 || /[\s\\#<>]/.test(url))
      fail("unavailable");
    if (/^\/(?!\/)/.test(url)) url = cfg.origin + url;
    const dest = url.match(/^(https:\/\/[a-zA-Z0-9.-]+(?::443)?)(?:[/?]|$)/);
    if (!dest) fail("unavailable");
    const origin = endpoint(dest[1]);
    let inspect = url;
    for (let i = 0; i < 2; i++) {
      try {
        inspect = decodeURIComponent(inspect);
      } catch (_) {
        break;
      }
    }
    if (
      /remix[_-]user(?:id|key)|(?:[?&])(?:password|email|authorization|cookie)=/i.test(inspect) ||
      [url, inspect].some((v) => v.indexOf(session.key) >= 0 || v.indexOf(cfg.email) >= 0)
    )
      fail("verification");
    const filename =
      (book.title
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
        .slice(0, 120)
        .trim() || "book") +
      "." +
      (book.extension || "bin");
    // Provider-issued CDN URLs are downloaded by the member. The shared session stays in Discourse.
    if (origin !== cfg.origin) return { download_url: url, filename, delivery: "provider" };
    // Authenticated, same-origin files can be delivered as ordinary private-message attachments.
    // Only known sizes up to 8 MiB are read into the Discourse tool runtime.
    if (!book.bytes || book.bytes > 8 * 1024 * 1024)
      return { download_url: url, filename, delivery: "provider" };
    const file = http.get(url, {
      headers: {
        Cookie: session.cookie,
        "Accept-Encoding": "identity",
        Range: "bytes=0-" + (book.bytes - 1),
      },
      base64Encode: true,
    });
    if (file && [301, 302, 303, 307, 308].includes(file.status))
      return { download_url: url, filename, delivery: "provider" };
    if (!file || ![200, 206].includes(file.status) || typeof file.body !== "string")
      fail("unavailable");
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(file.body) ||
      file.body.length !== Math.ceil(book.bytes / 3) * 4 ||
      (file.body.length * 3) / 4 -
        (file.body.endsWith("==") ? 2 : file.body.endsWith("=") ? 1 : 0) !==
        book.bytes
    )
      fail("incomplete");
    if (/^\s*(?:<!doctype\s+html|<html)/i.test(crypto.base64Decode(file.body.slice(0, 128))))
      fail("verification");
    const attachment = upload.create(filename, file.body);
    const short =
      attachment &&
      attachment.short_url &&
      attachment.short_url.match(/^upload:\/\/([a-zA-Z0-9]+\.[a-zA-Z0-9]+)$/);
    if (!short) fail("attachment");
    return {
      download_url: "/uploads/short-url/" + short[1],
      filename,
      delivery: "forum",
      short_url: attachment.short_url,
    };
  }
  let result;
  try {
    result = request.op === "search" ? search() : download();
  } catch (error) {
    const allowed = [
      "configuration",
      "account",
      "verification",
      "upstream",
      "unavailable",
      "quota",
      "rate_limited",
      "selection",
      "query",
      "incomplete",
      "attachment",
    ];
    result = { error: allowed.includes(error.message) ? error.message : "upstream" };
  }
  const payload = { marker: resultMark, nonce: request.nonce, result };
  let raw =
    resultMark +
    "\n\n```json\n" +
    JSON.stringify(payload).replace(/</g, "\\u003c").replace(/`/g, "\\u0060") +
    "\n```";
  if (result.short_url) raw += "\n\n[Download](" + result.short_url + ")";
  const reply = discourse.createPost({
    topic_id: post.topic_id,
    reply_to_post_number: post.post_number,
    raw,
  });
  if (!reply || reply.error) throw new Error("Unable to save the private book response");
  discourse.setCustomField("post", post.id, receiptKey, "done");
  return "handled";
}
