// Discourse AI Tool Action entry point. All provider requests run in the forum's server-side tool runtime.
function parseBookSearchFlags(input) {
  const command = input.trim();
  const start = command.search(/(?:^|\s)--(?:site|page)\b/i);
  if (start < 0) return { query: command };
  const options = { query: command.slice(0, start).trim() };
  const tokens = command.slice(start).trim().split(/\s+/);
  if (tokens.length !== 2 && tokens.length !== 4) return { error: "query" };
  for (let i = 0; i < tokens.length; i += 2) {
    const flag = tokens[i].toLowerCase();
    const value = tokens[i + 1];
    if (flag === "--site" && options.site === undefined && /^[1-3]$/.test(value)) {
      options.site = Number(value);
    } else if (flag === "--page" && options.page === undefined && /^\d{1,6}$/.test(value) && Number(value) > 0) {
      options.page = Number(value);
    } else {
      return { error: "query" };
    }
  }
  return options;
}

function invoke() {
  if (context.feature_name !== "ai_tool_action" || !(context.user_id > 0) || !context.post_id)
    return "ignored";
  const post = discourse.getPost(context.post_id);
  if (!post || post.id !== context.post_id || post.topic_id !== context.topic_id || post.user_id !== context.user_id)
    return "ignored";
  return processBookPost(post);
}

function processBookPost(post) {
  const requestMark = "book-library-request-v1";
  const resultMark = "book-library-result-v1";
  const cacheKey = "book_library_editions_v1";
  const receiptKey = "book_library_reply_v1";
  if (!post || !(post.user_id > 0) || !post.topic || typeof post.raw !== "string") return "ignored";
  const inTopic = post.topic.archetype === "regular";
  let bot = "ZlibBot";
  let request;
  let topicBook;
  let publicEdition;
  if (inTopic) {
    if (post.hidden || post.deleted_at || post.user_deleted || (post.post_type && post.post_type !== 1)) return "ignored";
    const mention = post.raw.trim().match(/^@([a-z0-9_-]+)(?=$|[\s:：,，])[\s:：,，]*([^\n]{0,260})\s*$/i);
    if (!mention && !post.reply_to_post_number) return "ignored";
    const options = accountOptions();
    bot = options.bot_username || bot;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,39}$/.test(bot) || sameBookUser(post.username, bot)) return "ignored";
    const addressed = mention && sameBookUser(mention[1], bot);
    const parent = directBookParent(post, bot);
    if (parent) {
      request = directBookRequest(addressed ? mention[2] : post.raw, parent);
    }
    if (addressed && (!request || (request.op === "reply" && request.kind === "clarify" && mention[2]))) {
      const flags = parseBookSearchFlags(mention[2]);
      request = { op: "search", command: flags.query, page: flags.page || 1, site: flags.site, invalid: flags.error };
    }
    if (!request) return "ignored";
  } else {
    if (post.topic.archetype !== "private_message" || !post.raw.startsWith(requestMark + "\n"))
      return "ignored";
    try { request = JSON.parse(post.raw.slice(requestMark.length + 1)); }
    catch (_) { return "ignored"; }
    if (!request || !/^[a-f0-9-]{36}$/.test(request.nonce) ||
        !["search", "download", "embed"].includes(request.op)) return "ignored";
  }
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
  function accountOptions() {
    try {
      return JSON.parse(secrets.get("book_account")) || {};
    } catch (_) {
      return {};
    }
  }
  function apiPath(value, fallback) {
    const path = value || fallback;
    if (typeof path !== "string" || !/^\/[a-z0-9_/{\}.-]+$/i.test(path) ||
        path.includes("//") || path.includes("..")) fail("configuration");
    return path;
  }
  function credentials() {
    const cfg = accountOptions();
    if (
      !cfg ||
      typeof cfg.email !== "string" ||
      typeof cfg.password !== "string" ||
      !cfg.email.trim() ||
      !cfg.password
    )
      fail("configuration");
    const filePath = apiPath(cfg.file_path, "/eapi/book/{id}/{hash}/file");
    if (!filePath.includes("{id}") || !filePath.includes("{hash}")) fail("configuration");
    let configuredOrigins = cfg.origins;
    if (typeof bookOriginsCredentialAlias !== "undefined") {
      try {
        configuredOrigins = JSON.parse(secrets.get(bookOriginsCredentialAlias));
      } catch (_) {
        fail("configuration");
      }
    }
    const legacy = configuredOrigins === undefined;
    let origins;
    if (legacy) {
      origins = [endpoint(cfg.origin)];
    } else {
      const approved = [
        "https://z-library.website", "https://z-lib.gd", "https://z-lib.sk",
        "https://z-library.sk", "https://z-lib.fm",
      ];
      if (!Array.isArray(configuredOrigins) || !configuredOrigins.length || configuredOrigins.length > 3)
        fail("configuration");
      origins = configuredOrigins.map(endpoint);
      if (origins.some((origin) => !approved.includes(origin)) || new Set(origins).size !== origins.length)
        fail("configuration");
    }
    return { origins, legacy, email: cfg.email.trim(), password: cfg.password,
      loginPath: apiPath(cfg.login_path, "/eapi/user/login"),
      searchPath: apiPath(cfg.search_path, "/eapi/book/search"), filePath };
  }
  function api(origin, path, params, session) {
    const headers = { Accept: "application/json", source: "android" };
    if (session) {
      headers["remix-userid"] = session.id;
      headers["remix-userkey"] = session.key;
      headers.Cookie = session.cookie;
    }
    let response;
    try {
      if (params) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        const body = Object.keys(params)
          .map((key) => encodeURIComponent(key) + "=" + encodeURIComponent(params[key]))
          .join("&");
        response = http.post(origin + path, { headers, body });
      } else {
        response = http.get(origin + path, { headers });
      }
    } catch (error) {
      // Retry only when the runtime identifies a failure before sending the HTTP request.
      const message = String(error && (error.message || error));
      if (/\b(?:SSL|TLS|certificate|Net::ReadTimeout)\b|SSL_connect/i.test(message))
        fail("upstream");
      const dnsFailure = /FinalDestination: lookup failed|\bgetaddrinfo (?:ENOTFOUND|EAI_AGAIN|EAI_NONAME)\b/i;
      const tcpFailure = /Failed to open TCP connection to \S+:\d+ \((?:Connection (?:timed out|refused)|execution expired|Network is unreachable|No route to host)\b|\bconnect (?:ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/i;
      fail(dnsFailure.test(message) || tcpFailure.test(message) ? "connection" : "upstream");
    }
    if (!response || typeof response.body !== "string" || response.body.length > 2000000)
      fail("upstream");
    let data;
    try {
      data = JSON.parse(response.body.replace(/^\uFEFF/, ""));
    } catch (_) {
      if (response.status === 429) fail("rate_limited");
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
  function login(cfg, origin) {
    const user = api(origin, cfg.loginPath, { email: cfg.email, password: cfg.password }).user;
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
      translator: text(row.translator),
      publisher: text(row.publisher),
      year: text(row.year, 12),
      language: text(row.language, 64),
      extension: /^[a-z0-9]{1,12}$/.test(extension) ? extension : "",
      size: text(row.filesizeString, 50) || (bytes > 0 ? bytes + " B" : ""),
      bytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null,
    };
  }
  function search() {
    if (!inTopic && typeof request.query === "string") {
      const flags = parseBookSearchFlags(request.query);
      if (flags.error || (flags.site !== undefined && request.site !== undefined && flags.site !== request.site))
        fail("query");
      request.query = flags.query;
      if (flags.page !== undefined) request.page = flags.page;
      if (flags.site !== undefined) request.site = flags.site;
    }
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
    const site = request.site;
    if (site !== undefined && (!Number.isInteger(site) || site < 1 || site > cfg.origins.length))
      fail("query");
    const origins = site === undefined ? cfg.origins : [cfg.origins[site - 1]];
    const form = { message: q.trim(), page: String(page), limit: "10" };
    if (extension) form["extensions[]"] = extension;
    let data, origin;
    for (const candidate of origins) {
      try {
        const session = login(cfg, candidate);
        data = api(candidate, cfg.searchPath, form, session);
        origin = candidate;
        break;
      } catch (error) {
        if (error.message !== "connection") throw error;
      }
    }
    if (!origin) fail("upstream");
    if (!Array.isArray(data.books)) fail("upstream");
    let rows = contextualEditions(data.books.slice(0, 10).map(record).filter(Boolean), topicBook);
    if (publicEdition) rows = rows.filter(row => samePublicEditionWork(row, publicEdition));
    if (request.chinese)
      rows = rows.filter(row => /chinese|中文|汉语|漢語|^zh\b|^chi$|^zho$/i.test(row.language));
    if (!topicBook || !topicBook.identify) discourse.setCustomField(
      "post",
      post.id,
      cacheKey,
      JSON.stringify({ expiry: Date.now() + 1200000, origin, rows }),
    );
    const current = Number(data.pagination && data.pagination.current) || page;
    const total = Number(data.pagination && data.pagination.total_pages) || null;
    return {
      query: q.trim(),
      site,
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
    if (!src || src.user_id !== post.user_id || !src.topic) fail("selection");
    const ownPrivateSearch = src.topic.archetype === "private_message" && src.topic_id === post.topic_id;
    const ownTopicSearch = src.topic.archetype === "regular" && src.topic_id === request.source_topic_id;
    if (!ownPrivateSearch && !ownTopicSearch) fail("selection");
    const saved = discourse.getCustomField("post", src.id, cacheKey);
    if (!saved) fail("selection");
    const data = JSON.parse(saved);
    const book = data.rows[Number(m[2])];
    if (!book || data.expiry <= Date.now()) fail("selection");
    if (request.op === "embed" && book.extension !== "epub") fail("selection");
    const cfg = credentials();
    const sourceOrigin = data.origin === undefined && cfg.legacy ? cfg.origins[0] : data.origin;
    if (!cfg.origins.includes(sourceOrigin)) fail("selection");
    const session = login(cfg, sourceOrigin);
    const filePath = cfg.filePath.replace("{id}", book.id).replace("{hash}", book.hash);
    const info = api(sourceOrigin, filePath, null, session);
    let url = (info.file && info.file.downloadLink) || info.downloadLink || info.url || info.link;
    if (typeof url !== "string" || !url || url.length > 8192 || /[\s\\#<>]/.test(url))
      fail("unavailable");
    if (/^\/(?!\/)/.test(url)) url = sourceOrigin + url;
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
    const privateLink =
      /remix[_-]user(?:id|key)|(?:[?&])(?:password|email|authorization|cookie)=/i.test(inspect) ||
      [url, inspect].some((value) =>
        [session.key, cfg.email, cfg.password].some((secret) => value.includes(secret)),
      );
    function providerLink(filename) {
      if (privateLink) fail("verification");
      return { download_url: url, filename, bytes: book.bytes, delivery: "provider" };
    }
    const filename =
      (book.title
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
        .slice(0, 120)
        .trim() || "book") +
      "." +
      (book.extension || "bin");
    // Provider-issued CDN URLs are downloaded by the member. The shared session stays in Discourse.
    if (origin !== sourceOrigin && (privateLink || request.op !== "embed")) return providerLink(filename);
    // Authenticated, same-origin files can be delivered as ordinary private-message attachments.
    // The Discourse tool has a 10 MB JavaScript heap. Leave headroom for Base64 and the upload bridge.
    if (!book.bytes || book.bytes > 2 * 1024 * 1024) return providerLink(filename);
    const fileHeaders = { "Accept-Encoding": "identity", Range: "bytes=0-" + (book.bytes - 1) };
    if (origin === sourceOrigin) fileHeaders.Cookie = session.cookie;
    const file = http.get(url, {
      headers: fileHeaders,
      base64Encode: true,
    });
    if (file && [301, 302, 303, 307, 308].includes(file.status)) return providerLink(filename);
    if (!file || ![200, 206].includes(file.status) || typeof file.body !== "string")
      fail("unavailable");
    if (
      file.body.length !== Math.ceil(book.bytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(file.body) ||
      (file.body.length * 3) / 4 -
        (file.body.endsWith("==") ? 2 : file.body.endsWith("=") ? 1 : 0) !==
        book.bytes
    )
      fail("incomplete");
    // Decode only ASCII header bytes. A binary PDF or ZIP prefix is not a UTF-8 string.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let prefix = "",
      bits = 0,
      carry = 0;
    for (const char of file.body.slice(0, 128)) {
      const digit = alphabet.indexOf(char);
      if (digit < 0) break;
      carry = (carry << 6) | digit;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        prefix += String.fromCharCode((carry >> bits) & 255);
      }
    }
    if (/^(?:\xEF\xBB\xBF)?\s*(?:<!doctype\s+html|<html)/i.test(prefix)) fail("verification");
    if (request.op === "embed" && !prefix.startsWith("PK\x03\x04")) fail("incomplete");
    const attachment = upload.create(filename, file.body);
    const short =
      attachment &&
      attachment.short_url &&
      attachment.short_url.match(/^upload:\/\/([a-zA-Z0-9]+\.[a-zA-Z0-9]+)$/);
    if (!short) fail("attachment");
    return {
      download_url: "/uploads/short-url/" + short[1],
      filename,
      bytes: book.bytes,
      delivery: "forum",
      short_url: attachment.short_url,
    };
  }
  let result;
  try {
    if (request.invalid) fail("query");
    if (inTopic && request.command !== undefined) {
      topicBook = resolveTopicBook(post, request.command);
      request.query = topicBook.query;
    }
    if (inTopic && !topicBook?.identify) publicEdition = publicEditionFor(request.query);
    if (request.op !== "reply") result = request.op === "search" ? search() : download();
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
  function label(value) {
    return text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/@/g, "＠").replace(/[\\[\]()*_~|\x60]/g, "\\$&");
  }
  function topicReply() {
    if (request.op === "reply") {
      if (request.kind === "thanks") return "不客氣！";
      if (request.kind === "encouragement") return "謝謝你鼓勵我：）想找哪本書？";
      if (request.previous && request.previous.query)
        return "你想繼續找《" + label(request.previous.query) + "》嗎？可以告訴我需要哪種格式，或給我另一個書名。";
      return "你想找哪本書？請告訴我書名、作者或 ISBN。";
    }
    if (topicBook && topicBook.identify && !request.query)
      return "從這篇帖子裡還無法確定收錄作品的書名。請補充書名、ISBN，或貼出註明出處的那一行。";
    if (request.invalid || (request.site && result.error === "query" && request.query)) return "搜尋選項有誤。請將 --page 設為正整數，--site 設為論壇已設定的站點編號。";
    if (result.error === "query") return "請在 @" + bot + " 後補充書名、作者或 ISBN。";
    if (topicBook && topicBook.identify) {
      const title = topicBook.titles && topicBook.titles[0] || request.query;
      const lines = [];
      if (topicBook.known) {
        lines.push(topicBook.known.citation);
        const translation = topicBook.known.translations.find(entry => entry.names.includes(topicBook.translator));
        if (translation) lines.push(translation.citation);
      } else if (topicBook.citationUrl) {
        lines.push(label(topicBook.author) + "的〈" + label(topicBook.story) + "〉收在《" + label(title) + "》。[Wikidata 作品書目](" + topicBook.citationUrl + ")");
      } else {
        lines.push("帖子標註的" + (topicBook.container ? "出處" : "書目") + "是《" + label(title) + "》。[查閱圖書館目錄](https://search.worldcat.org/search?q=" + encodeURIComponent(request.query) + ")");
      }
      if (!result.error && result.books.length) {
        lines.push("本頁符合的書目資料如下。");
        lines.push(result.books.map(book => [book.title, book.author, book.translator && "譯者 " + book.translator,
          book.publisher, book.year, book.language, book.extension.toUpperCase()].filter(Boolean).map(label).join(" · "))
          .map(caption => "* " + caption).join("\n"));
      } else if (result.error) lines.push("書庫查詢暫時失敗（" + result.error + "）。");
      else lines.push("這一頁沒有符合的書庫版本。");
      return lines.join("\n\n");
    }
    if (result.error) return "書庫目前無法完成搜尋（" + result.error + "）。";
    if (!result.books.length) return "查無「" + label(request.query) + "」的版本。";
    const lines = ["「" + label(request.query) + "」的搜尋結果。點選需要的版本，再選擇嵌入或下載。", ""];
    result.books.forEach((book, index) => {
      const caption = [book.title, book.author, book.publisher, book.year, book.language,
        book.extension.toUpperCase(), book.size].filter(Boolean).map(label).join(" · ");
      const url = discourse.baseUrl + "/t/" + post.topic_id + "/" + post.post_number +
        "#zlibrary-edition-" + book.selection + "-" + (book.extension || "bin");
      lines.push((index + 1) + ". [" + caption + "](" + url + ")");
    });
    if (result.has_next) lines.push("", "下一頁可回覆：" + String.fromCharCode(96) + "@" + bot + " " +
      text(request.query, 200).replace(/\x60/g, "") + (request.site ? " --site " + request.site : "") +
      " --page " + (result.page + 1) + String.fromCharCode(96));
    return lines.join("\n");
  }
  let raw;
  if (inTopic) {
    raw = topicReply();
    if (publicEdition && !request.chinese && (!request.extension || request.extension === "epub")) {
      raw += "\n\n[" + publicEdition.author + "《" + publicEdition.title + "》英文原著 EPUB（" +
        publicEdition.publisher + "）](" + publicEdition.epub + ")";
    }
  } else {
    const payload = { marker: resultMark, nonce: request.nonce, result };
    raw = resultMark + "\n\n```json\n" +
      JSON.stringify(payload).replace(/</g, "\\u003c").replace(/\x60/g, "\\u0060") + "\n```";
    if (result.short_url) raw += "\n\n[Download](" + result.short_url + ")";
  }
  const reply = discourse.createPost({
    topic_id: post.topic_id,
    reply_to_post_number: post.post_number,
    ...(inTopic ? { username: bot } : {}),
    raw,
  });
  if (!reply || reply.error) throw new Error("Unable to save the book response");
  discourse.setCustomField("post", post.id, receiptKey, "done");
  if (inTopic) {
    const search = request.op === "search" && request.query && !request.invalid && request.query.length <= 200 ?
      { query: request.query, page: request.page, site: request.site, extension: request.extension, chinese: request.chinese } : request.previous;
    bookReplyIndex(post.topic_id, reply, post, search);
  }
  return "handled";
}
