import { createHandler } from "../service/worker.mjs";

export const forum = "https://forum.example";
export const pdf = new TextEncoder().encode("%PDF-1.4\nFixture\n%%EOF\n");
export function fixture() {
  const calls = [];
  const responses = [];
  const allow = { limit: async () => ({ success: true }) };
  const env = {
    FORUM_ORIGIN: forum,
    ZLIBRARY_ORIGIN: "https://books.example",
    ZLIBRARY_FILE_HOSTS: "cdn.example",
    ZLIBRARY_EMAIL: "test@example.invalid",
    ZLIBRARY_PASSWORD: "only-a-fixture",
    SELECTION_SECRET: "only for tests, a long test signing key",
    SEARCH_LIMIT: allow,
    DOWNLOAD_LIMIT: allow,
  };
  const state = {
    member: async (options) =>
      Response.json({ current_user: { id: options.headers.Cookie.includes("_t=other") ? 2 : 1 } }),
  };
  const api = createHandler(async (url, options) => {
    const u = new URL(url);
    calls.push({ u, options });
    if (u.origin === forum && u.pathname === "/session/current.json") return state.member(options);
    if (responses.length) return responses.shift()(u, options);
    if (u.pathname === "/eapi/user/login")
      return Response.json({ success: 1, user: { id: 7, remix_userkey: "upstream-test-key" } });
    if (u.pathname === "/eapi/book/search")
      return Response.json({
        success: 1,
        pagination: { current: 1, total_pages: 2 },
        books: [
          { id: 51, hash: "abc", title: "試讀本", year: 1900, extension: "epub" },
          { id: 53, hash: "def", title: "試讀本", year: 1910, extension: "pdf" },
        ],
      });
    if (u.pathname === "/eapi/book/53/def/file")
      return Response.json({ success: 1, file: { downloadLink: "https://cdn.example/book" } });
    if (u.href === "https://cdn.example/book")
      return new Response(pdf, { headers: { "Content-Length": String(pdf.length) } });
    throw Error("Unexpected fixture request: " + u.pathname);
  });
  const request = (operation, body, extra = {}) =>
    api.fetch(
      new Request(forum + "/z-library-api/" + operation, {
        method: "POST",
        headers: {
          Origin: forum,
          Cookie: "_t=member; unneeded=omit",
          "Content-Type": "application/json",
          "X-Zlibrary-Request": "1",
          ...extra,
        },
        body: JSON.stringify(body),
      }),
      env,
    );
  const search = async () => await (await request("search", { query: "試讀本" })).json();
  return { calls, responses, env, api, state, request, search };
}
