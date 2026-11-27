import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const native = (name) => readFileSync(new URL("../native/" + name, import.meta.url), "utf8");
function tools(discourse = {}, http = {}) {
  const sandbox = vm.createContext({ discourse, http });
  const source = [native("topic-query.js"), native("bot-reply.js"), native("book-tool.js")].join("\n");
  vm.runInContext(source, sandbox);
  return sandbox;
}

test("preserves reader keywords, spelling and incidental format words and extracts only explicit syntax", () => {
  const s = tools();
  const samples = [
    ["为我找到盐的英文版，无删减版本", "盐"],
    ["请帮我找一下《小王子》好吗？", "小王子"],
    ["找一下《英文版 PDF Explained》 的 EPUB 版", "英文版 PDF Explained"],
    ["The English Patient", "The English Patient"],
    ["Find Me", "Find Me"],
    ["Search Engine", "Search Engine"],
    ["search engine", "search engine"],
    ["search:Gravity", "Gravity"],
    ["關鍵詞：《A》 OR 《B》的英文版", "《A》 OR 《B》的英文版"],
    ['A History of “Time”', 'A History of “Time”'],
    ["ISBN：978-1-78227-093-5", "978-1-78227-093-5"],
    ["作者：Ursula K. Le Guin", "Ursula K. Le Guin"],
    ["A  Tale of Two Cities", "A  Tale of Two Cities"],
    ["PDF Explained", "PDF Explained"],
    ["《Gravity's Rainbow》还是《V.》？", ""],
  ];
  for (const [command, query] of samples) assert.equal(s.literalBookKeyword(command).query, query, command);
  assert.equal(s.literalBookKeyword("找《The Book》 的 PDF 版").extension, "pdf");
});

test("a bare mention uses an identified parent's actual request or the literal topic title", () => {
  const topic = { id: 10, archetype: "regular", title: "Original title" };
  const mention = { topic, topic_id: 10, post_number: 9, reply_to_post_number: 8 };
  const parent = { id: 23, topic_id: 10, post_number: 8, post_type: 1, raw: "为我找到盐的英文版，无删减版本" };
  const s = tools({ getPost: () => parent, baseUrl: "https://forum.example" }, {
    get: () => ({ status: 403, body: "{}" }),
  });
  assert.equal(s.resolveTopicBook({ ...mention, reply_to_post_id: 23 }, "").query, "盐");
  assert.equal(s.resolveTopicBook(mention, "").query, "Original title");
  assert.equal(s.resolveTopicBook(mention, "《甲》《乙》").query, "");
  assert.equal(s.resolveTopicBook(mention, "Find Me").query, "Find Me");
});

test("an unmentioned bot reply accepts new literal titles, retries, paging and format with no guessed new subject", () => {
  const s = tools(), p = { search: { query: "Unchanged keyword", page: 2, site: 2, extension: "epub" } };
  for (const raw of ["再试一次", "你要相信自己：）", "下一頁", "--page 3"])
    assert.equal(s.directBookRequest(raw, p).query, "Unchanged keyword");
  assert.equal(s.directBookRequest("下一頁", p).page, 3);
  assert.equal(s.directBookRequest("可以找 PDF 版嗎？", p).extension, "pdf");
  assert.equal(s.directBookRequest("A Different Title", p).query, "A Different Title");
  assert.equal(s.directBookRequest("A Different Title", p).page, 1);
  assert.equal(s.directBookRequest("謝謝", p).op, "reply");
});

test("a pre-upgrade inherited collection cannot replace the reader's original keyword", () => {
  const topic = { id: 10, archetype: "regular", title: "Original title" };
  const post = (id, number, user_id, username, raw, parent) => ({
    id, post_number: number, post_type: 1, user_id, username, raw, topic_id: 10, topic, reply_to_post_number: parent,
  });
  const source = post(32, 2, 14, "reader", "@ZlibBot 为我找到盐的英文版，无删减版本");
  const bot = post(34, 3, -7, "ZlibBot", "old results", 2);
  const next = post(40, 4, 14, "reader", "下一頁", 3);
  const s = tools({ getPost: id => id === 32 ? source : bot,
    getCustomField: () => JSON.stringify({ id: 34, requestId: 32, search: { query: "An inferred collection" } }) });
  const prev = s.directBookParent(next, "ZlibBot");
  assert.equal(s.directBookRequest(next.raw, prev).query, "盐");
});
