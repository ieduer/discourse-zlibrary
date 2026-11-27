import { readFileSync, writeFileSync } from "node:fs";
const script = readFileSync(new URL("./book-tool.js", import.meta.url), "utf8");
const tool = {
  ai_tool: {
    name: "Forum Book Library",
    tool_name: "forum_book_library",
    summary: "Search for editions in forum topics and prepare the edition a member selects.",
    description: "Responds to book-bot mentions in public topics and handles selection, download and EPUB requests in the dedicated group inbox.",
    parameters: [],
    secret_contracts: [{ alias: "book_account" }],
    script,
  },
};
const file = new URL("./forum-book-tool.json", import.meta.url);
const data = JSON.stringify(tool, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(file, "utf8") !== data) throw new Error("Tool import file is out of date");
} else {
  writeFileSync(file, data);
}
