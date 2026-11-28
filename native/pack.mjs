import { readFileSync, writeFileSync } from "node:fs";
const script = ["./topic-query.js", "./bot-reply.js", "./book-tool.js"]
  .map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
const tool = {
  ai_tool: {
    name: "Forum Book Library",
    tool_name: "forum_book_library",
    summary: "Search for editions in forum topics and prepare the edition a member selects.",
    description: "Answers public mentions and direct replies to the book bot and updates a reader-owned archived workspace for search, download and EPUB without sending private replies.",
    parameters: [],
    secret_contracts: [{ alias: "book_account" }],
    script,
  },
};
// The forum requires every declared credential to be bound before it starts the tool.
const withOrigins = {
  ai_tool: {
    ...tool.ai_tool,
    secret_contracts: [...tool.ai_tool.secret_contracts, { alias: "book_origins" }],
    script: 'var bookOriginsCredentialAlias = "book_origins";\n' + script,
  },
};
for (const [name, value] of [
  ["forum-book-tool.json", tool],
  ["forum-book-tool-origins.json", withOrigins],
]) {
  const file = new URL(name, import.meta.url);
  const data = JSON.stringify(value, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    if (readFileSync(file, "utf8") !== data) throw new Error(name + " is out of date");
  } else {
    writeFileSync(file, data);
  }
}
