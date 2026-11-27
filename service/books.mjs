const statuses = {
  configuration: 503,
  membership: 403,
  query: 422,
  selection: 422,
  account: 503,
  verification: 503,
  upstream: 502,
  timeout: 504,
  unavailable: 404,
  quota: 429,
  rate_limited: 429,
  too_large: 413,
  incomplete: 502,
  file_host: 502,
};
export class Problem extends Error {
  constructor(code) {
    super(code);
    this.status = statuses[code];
  }
}

export async function boundedJSON(body, limit, invalid) {
  const reader = body?.getReader();
  if (!reader) throw new Problem(invalid);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Problem(invalid);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") throw new Problem("timeout");
    throw new Problem(invalid);
  } finally {
    reader.releaseLock();
  }
}

const formats = new Set(["", "epub", "pdf", "mobi", "azw3", "djvu", "fb2", "txt"]);
const part = /^[a-zA-Z0-9_-]{1,128}$/;
const clean = (v, max = 300) =>
  typeof v === "string" || typeof v === "number"
    ? String(v)
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .trim()
        .slice(0, max)
    : "";
const positive = (v) => (/^\d{1,15}$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);

function normalize(row) {
  if (
    !row ||
    !["string", "number"].includes(typeof row.id) ||
    !part.test(String(row.id)) ||
    typeof row.hash !== "string" ||
    !part.test(row.hash)
  )
    return null;
  const title = clean(row.title);
  if (!title) return null;
  const ext = clean(row.extension, 12).toLowerCase();
  const bytes = positive(row.filesize);
  return {
    id: String(row.id),
    hash: row.hash,
    title,
    author: clean(row.author),
    publisher: clean(row.publisher),
    year: clean(row.year, 12),
    language: clean(row.language, 64),
    bytes,
    size: clean(row.filesizeString, 48) || (bytes ? `${bytes} B` : ""),
    extension: /^[a-z0-9]{1,12}$/.test(ext) ? ext : "",
  };
}

export function checkedOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    )
      return url.origin;
  } catch {}
  throw new Problem("configuration");
}

export class BookService {
  constructor(env, fetcher, sessions) {
    this.env = env;
    this.fetch = fetcher;
    this.sessions = sessions;
    this.origin = checkedOrigin(env.ZLIBRARY_ORIGIN);
    if (!env.ZLIBRARY_EMAIL || !env.ZLIBRARY_PASSWORD) throw new Problem("configuration");
  }

  async api(path, form, session) {
    const headers = {
      Accept: "application/json",
      source: "android",
      "User-Agent": "Discourse-Book-Library/2.0",
    };
    if (session) {
      headers["remix-userid"] = session.id;
      headers["remix-userkey"] = session.key;
      headers.Cookie = this.cookie(session);
    }
    const r = await this.fetch(this.origin + path, {
      headers,
      redirect: "manual",
      cache: "no-store",
      method: form ? "POST" : "GET",
      body: form ? new URLSearchParams(form) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const html = /html/i.test(r.headers.get("content-type") || "");
    const data = await boundedJSON(r.body, 2 * 1024 * 1024, "upstream").catch((error) => {
      if (error.message === "timeout") throw error;
      return null;
    });
    if (r.ok && String(data?.success) === "1") return data;
    const detail = String(data?.error || "")
      .trim()
      .toLowerCase();
    if (/quota|daily.{0,35}limit|download.{0,35}limit|limit.{0,35}download/.test(detail))
      throw new Problem("quota");
    if (r.status === 429) throw new Problem("rate_limited");
    if (
      session &&
      (r.status === 401 ||
        ["invalid credentials", "not logged in", "please login", "please log in"].includes(detail))
    ) {
      throw new Problem("account");
    }
    if (r.status === 403 || html || /captcha|challenge|verification/.test(detail))
      throw new Problem("verification");
    if (r.status === 404 || /book not found|file not found/.test(detail))
      throw new Problem("unavailable");
    if (!session && (r.status === 401 || String(data?.success) === "0"))
      throw new Problem("account");
    throw new Problem("upstream");
  }

  cookie(s) {
    return `remix_userid=${s.id}; remix_userkey=${s.key}`;
  }

  async login() {
    const cached = this.sessions.get(this.env);
    if (cached && cached.expires > Date.now()) return cached;
    const { user } = await this.api("/eapi/user/login", {
      email: this.env.ZLIBRARY_EMAIL,
      password: this.env.ZLIBRARY_PASSWORD,
    });
    const key = user?.remix_userkey || user?.remix_user_key;
    if (
      !/^\d{1,32}$/.test(String(user?.id)) ||
      typeof key !== "string" ||
      !/^[\w.~%+=/-]{1,512}$/.test(key)
    ) {
      throw new Problem("account");
    }
    const s = { id: String(user.id), key, expires: Date.now() + 15 * 60000 };
    this.sessions.set(this.env, s);
    return s;
  }

  async authenticated(path, form) {
    const first = await this.login();
    try {
      return [await this.api(path, form, first), first];
    } catch (error) {
      if (!(error instanceof Problem) || error.message !== "account") throw error;
      if (this.sessions.get(this.env) === first) this.sessions.delete(this.env);
      const next = await this.login();
      try {
        return [await this.api(path, form, next), next];
      } catch (retry) {
        if (retry.message === "account" && this.sessions.get(this.env) === next)
          this.sessions.delete(this.env);
        throw retry;
      }
    }
  }

  async search({ query, page = 1, extension = "" }) {
    if (
      typeof query !== "string" ||
      !query.trim() ||
      query.trim().length > 200 ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 999999 ||
      !formats.has(extension)
    )
      throw new Problem("query");
    const form = { message: query.trim(), page: String(page), limit: "20" };
    if (extension) form["extensions[]"] = extension;
    const [data] = await this.authenticated("/eapi/book/search", form);
    if (!Array.isArray(data.books)) throw new Problem("upstream");
    const current = positive(data.pagination?.current) || page;
    const total = positive(data.pagination?.total_pages);
    return {
      books: data.books.slice(0, 20).map(normalize).filter(Boolean),
      page: current,
      total_pages: total,
      has_next: total ? current < total : data.books.length >= 20,
    };
  }

  fileURL(value, base) {
    if (typeof value !== "string" || !value || value.length > 8192)
      throw new Problem("unavailable");
    let url;
    try {
      url = new URL(value, base);
    } catch {
      throw new Problem("file_host");
    }
    const hosts = String(this.env.ZLIBRARY_FILE_HOSTS || "")
      .toLowerCase()
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !(url.origin === this.origin || hosts.includes(url.hostname))
    )
      throw new Problem("file_host");
    return url;
  }

  async file(book, maxBytes) {
    if (book.bytes > maxBytes) throw new Problem("too_large");
    const [data, session] = await this.authenticated(`/eapi/book/${book.id}/${book.hash}/file`);
    let url = this.fileURL(
      data.file?.downloadLink || data.downloadLink || data.url || data.link,
      this.origin,
    );
    const signal = AbortSignal.timeout(90000);
    for (let i = 0; i < 5; i++) {
      const headers = { "Accept-Encoding": "identity" };
      if (url.origin === this.origin) headers.Cookie = this.cookie(session);
      const response = await this.fetch(url.toString(), {
        headers,
        signal,
        redirect: "manual",
        cache: "no-store",
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        url = this.fileURL(response.headers.get("Location"), url);
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new Problem("verification");
        if ([404, 410].includes(response.status)) throw new Problem("unavailable");
        throw new Problem(response.status === 429 ? "rate_limited" : "upstream");
      }
      return checkedFile(response, book, maxBytes);
    }
    throw new Problem("upstream");
  }
}

async function checkedFile(response, book, maxBytes) {
  const type = response.headers.get("Content-Type") || "";
  const length = response.headers.get("Content-Length");
  const expected = length === null ? null : Number(length);
  const reader = response.body?.getReader();
  if (!reader) throw new Problem("incomplete");
  try {
    if (/html|(?:\/|\+)json/i.test(type)) throw new Problem("verification");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(expected)))
      throw new Problem("incomplete");
    if (expected > maxBytes) throw new Problem("too_large");
    if (!["", "identity"].includes((response.headers.get("content-encoding") || "").toLowerCase()))
      throw new Problem("upstream");
    let count = 0;
    const first = [];
    const prefix = new Uint8Array(256);
    let used = 0,
      ended = false;
    while (used < prefix.length) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      count += value.length;
      if (count > maxBytes) throw new Problem("too_large");
      if (expected !== null && count > expected) throw new Problem("incomplete");
      const part = value.subarray(0, prefix.length - used);
      prefix.set(part, used);
      used += part.length;
      first.push(value);
    }
    if (!count || (ended && expected !== null && count !== expected))
      throw new Problem("incomplete");
    if (
      /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(new TextDecoder().decode(prefix.subarray(0, used)))
    )
      throw new Problem("verification");
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          if (first.length) {
            controller.enqueue(first.shift());
            return;
          }
          if (!ended) {
            const { done, value } = await reader.read();
            if (!done) {
              count += value.length;
              if (count > maxBytes || (expected !== null && count > expected))
                throw new Problem("incomplete");
              controller.enqueue(value);
              return;
            }
          }
          if (expected !== null && count !== expected) throw new Problem("incomplete");
          reader.releaseLock();
          controller.close();
        } catch (error) {
          await reader.cancel().catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    const ext = /^[a-z0-9]{1,12}$/.test(book.extension) ? book.extension : "bin";
    let stem = book.title.replace(/[\p{Cc}\p{Cf}\\/:*?"<>|]/gu, " ").replace(/^\.+|[. ]+$/g, "");
    if (stem.toLowerCase().endsWith("." + ext)) stem = stem.slice(0, -(ext.length + 1));
    stem = [...stem].slice(0, 52).join("").trim() || "book";
    const filename = encodeURIComponent(stem.toWellFormed() + "." + ext).replace(
      /['()*]/g,
      (ch) => "%" + ch.charCodeAt(0).toString(16),
    );
    const headers = {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="book.${ext}"; filename*=UTF-8''${filename}`,
    };
    return new Response(stream, { headers });
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}
