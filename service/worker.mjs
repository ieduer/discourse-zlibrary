import { BookService, Problem, boundedJSON, checkedOrigin } from "./books.mjs";

const utf8 = new TextEncoder();
const responseHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

function pack(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function unpack(value) {
  if (!/^[\w-]+$/.test(value)) throw new Problem("selection");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
function signingKey(env) {
  if (typeof env.SELECTION_SECRET !== "string" || utf8.encode(env.SELECTION_SECRET).length < 32)
    throw new Problem("configuration");
  return crypto.subtle.importKey(
    "raw",
    utf8.encode(env.SELECTION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function ticket(key, site, user, book) {
  const { id, hash, title, extension, bytes } = book;
  const data = utf8.encode(
    JSON.stringify({
      site,
      user,
      exp: Date.now() + 20 * 60000,
      book: { id, hash, title, extension, bytes },
    }),
  );
  return pack(data) + "." + pack(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}
async function selected(key, token, site, user) {
  try {
    if (typeof token !== "string" || token.length > 4096) throw 0;
    const parts = token.split(".");
    if (parts.length !== 2) throw 0;
    const data = unpack(parts[0]);
    if (!(await crypto.subtle.verify("HMAC", key, unpack(parts[1]), data))) throw 0;
    const value = JSON.parse(new TextDecoder().decode(data));
    if (value.site !== site || value.user !== user || value.exp <= Date.now()) throw 0;
    return value.book;
  } catch {
    throw new Problem("selection");
  }
}
async function member(request, forum, fetcher) {
  const cookies = (request.headers.get("Cookie") || "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => /^(?:_t|_forum_session)=[^\s;]+$/.test(v));
  if (!cookies.some((v) => v.startsWith("_t="))) throw new Problem("membership");
  const r = await fetcher(forum + "/session/current.json", {
    headers: {
      Cookie: cookies.join("; "),
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Problem(r.status >= 500 ? "upstream" : "membership");
  }
  const data = await boundedJSON(r.body, 1024 * 1024, "membership");
  const id = data?.current_user?.id;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Problem("membership");
  return id;
}

export function createHandler(fetcher = (...args) => fetch(...args)) {
  // Each deployment environment caches only its service account's short-lived login strings.
  const sessions = new WeakMap();
  return {
    async fetch(request, env) {
      let limit = 128;
      try {
        const forum = checkedOrigin(env.FORUM_ORIGIN);
        const url = new URL(request.url);
        const prefix = env.BOOK_SERVICE_PATH || "/z-library-api";
        const operation =
          url.pathname === prefix + "/search"
            ? "search"
            : url.pathname === prefix + "/download"
              ? "download"
              : null;
        if (!operation || url.origin !== forum || url.search)
          return new Response(null, { status: 404, headers: responseHeaders });
        if (request.method !== "POST")
          return new Response(null, {
            status: 405,
            headers: { ...responseHeaders, Allow: "POST" },
          });
        if (
          request.headers.get("Origin") !== forum ||
          request.headers.get("X-Zlibrary-Request") !== "1"
        )
          throw new Problem("membership");
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || ""))
          throw new Problem("query");
        const body = await boundedJSON(request.body, 12 * 1024, "query");
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Problem("query");
        const uid = await member(request, forum, fetcher);
        const limiter = operation === "search" ? env.SEARCH_LIMIT : env.DOWNLOAD_LIMIT;
        if (!limiter) throw new Problem("configuration");
        if (!(await limiter.limit({ key: String(uid) })).success) throw new Problem("rate_limited");
        const key = await signingKey(env);
        const books = new BookService(env, fetcher, sessions);
        if (operation === "search") {
          const result = await books.search(body);
          result.books = await Promise.all(
            result.books.map(async (record) => {
              const selection = await ticket(key, forum, uid, record);
              const { id, hash, ...metadata } = record;
              return { ...metadata, selection };
            }),
          );
          return Response.json(result, { headers: responseHeaders });
        }
        limit = body.hub === true ? 25 : 128;
        return await books.file(
          await selected(key, body.selection, forum, uid),
          limit * 1024 * 1024,
        );
      } catch (error) {
        const p =
          error instanceof Problem
            ? error
            : new Problem(
                ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "upstream",
              );
        return Response.json(
          { error: p.message, limit },
          { status: p.status, headers: responseHeaders },
        );
      }
    },
  };
}
export default createHandler();
