// Extract only words supplied by the member. An empty query asks for a keyword.
function literalBookKeyword(input) {
  if (typeof input !== "string" || input.length > 500) return { query: "" };
  const raw = input.trim();
  const verbatim = raw.match(/^(?:關鍵詞|关键词|關鍵字|关键字|keyword)\s*[:：]\s*(.+)$/i);
  if (verbatim) {
    const query = verbatim[1].trim();
    return { query: query.length <= 200 ? query : "" };
  }
  const marked = [...raw.matchAll(/《([^《》\n]+)》|〈([^〈〉\n]+)〉|「([^「」\n]+)」|“([^“”\n]+)”|"([^"\n]+)"/g)]
    .map(match => match.slice(1).find(Boolean).trim());
  if (new Set(marked).size > 1) return { query: "" };
  const outside = marked.length ? raw.replace(/《[^《》\n]+》|〈[^〈〉\n]+〉|「[^「」\n]+」|“[^“”\n]+”|"[^"\n]+"/g, " ") : raw;
  // A format word in a title (e.g. "PDF Explained") is a keyword unless explicitly used as a filter.
  const format = outside.match(/(?:^|[的，,、\s])(?:格式\s*[:：]?\s*|in\s+)?(epub|pdf|mobi|azw3|djvu|fb2|txt)(?:\s*(?:格式|版(?:本)?|format))?[。.!！?？\s]*$/i);
  const extension = format && (marked.length || format[0].trim() === raw || /(?:格式|版|\bin\s|\bformat|的|，|,)/i.test(format[0])) ? format[1].toLowerCase() : undefined;
  const finish = (query) => query && query.length <= 200 ? { query, ...(extension ? { extension } : {}) } : { query: "", ...(extension ? { extension } : {}) };
  if (marked.length && (!outside.trim() || /^(?:[请請幫帮為为找搜想要需查]|(?:please )?(?:find|search|look up)\b)/i.test(outside.trim()) || extension)) return finish(marked[0]);
  const bookId = raw.match(/^(?:ISBN(?:-1[03])?\s*[:：]?\s*)?((?:97[89][\s-]*)?(?:\d[\s-]*){9}[\dX])$/i);
  if (bookId) return finish(bookId[1].trim());
  const label = raw.match(/^(?:關鍵詞|关键词|關鍵字|关键字|作者|書名|书名|keyword|author|title)\s*[:：]\s*(.+)$/i);
  if (label) return finish(label[1].trim());
  const commandPrefix = /^(?:(?:麻[煩烦]|[請请])\s*)?(?:(?:[幫帮為为給给]我|我想)\s*)?(?:[幫帮]忙\s*)?(?:[尋寻]找|搜[索尋寻]|[檢检]索|找(?:到|一下|找|[書书])?)\s*[:：]?\s*|^(?:please\s+(?:find|search(?:\s+for)?)\s+|(?:find|search)\s*:\s*|search\s+for\s+)/i;
  const hasPrefix = commandPrefix.test(raw);
  let query = hasPrefix ? raw.replace(commandPrefix, "") : raw;
  if (extension) query = query.replace(format[0], "");
  // Strip version qualifications when expressed as such, never translate or replace the noun.
  if (hasPrefix) query = query.replace(/(?:[好可]?[嗎吗][？?]?|[。？?])$/, "").trim()
    .replace(/(?:[，,、]\s*)?(?:[无無未][删刪][减減节節]|未[節节][選选])版(?:本)?[。.!！?？\s]*$/, "")
    .replace(/的(?:英[文语語]|中[文譯译]|法[文语語]|德[文语語]|日[文语語]|俄[文语語]|西班牙[文语語])(?:原版|版(?:本)?|[譯译]本)[。.!！?？\s]*$/, "");
  query = query.trim();
  if (!query || /[\n\r]/.test(query) || /^(?:[這这那此本][一]?[篇本文册冊部]|原帖|主帖|首帖|上[一层層樓楼]|this (?:book|story|post)|original post)(?:$|[這这那書书的出里裡中所提是收选選？?])|哪(?:一)?本[書书]|what book is this|which book is this/i.test(query))
    return finish("");
  return finish(query);
}

function resolveTopicBook(post, command) {
  const literal = literalBookKeyword(command);
  if (literal.query) return literal;
  // A referential lookup can reuse an explicitly supplied keyword, or the actual topic title.
  // Multiple quoted works are ambiguous even when the topic itself has a title.
  if ((command.match(/[《〈「“]/g) || []).length > 1 || !post?.topic || post.topic.archetype !== "regular") return literal;
  if (command && !/原帖|首帖|主帖|[這这此][篇本文]|哪本[書书]|this (?:book|post|story)|original post/i.test(command)) return literal;
  const number = post.reply_to_post_number;
  if (number > 1 && number < post.post_number && !/原帖|首帖|主帖|original post/i.test(command)) {
    let parent;
    if (Number.isSafeInteger(post.reply_to_post_id)) parent = discourse.getPost(post.reply_to_post_id);
    else {
      try {
        const result = http.get(discourse.baseUrl + "/posts/by_number/" + post.topic_id + "/" + number + ".json", { headers: { Accept: "application/json" } });
        if (result.status === 200 && typeof result.body === "string" && result.body.length <= 1500000) parent = JSON.parse(result.body);
      } catch (_) { /* an unavailable public post supplies no keyword */ }
    }
    if (parent?.topic_id === post.topic_id && parent.post_number === number && parent.post_type === 1 &&
        !parent.hidden && !parent.deleted_at && !parent.user_deleted && typeof parent.raw === "string" && parent.raw.length <= 260 &&
        /[《〈「“]|(?:[幫帮為为給给]我|請|请)\s*(?:找|搜)|^(?:書名|书名|作者|ISBN)\s*[:：]/i.test(parent.raw)) {
      const previous = literalBookKeyword(parent.raw);
      if (previous.query) return previous;
    }
  }
  const title = post.topic.title?.trim();
  return title && title.length <= 200 ? { ...literal, query: title } : literal;
}
