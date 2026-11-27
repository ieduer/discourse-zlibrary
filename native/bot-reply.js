// The tool runner returns raw posts by global ID, while a reply identifies its parent by topic-local number.
function bookReplyKey(number) {
  return "book_library_bot_post_" + number;
}

function visibleBookPost(post, topicId, number) {
  return post && post.topic_id === topicId && post.post_number === number && post.post_type === 1 &&
    post.topic && post.topic.archetype === "regular" && !post.hidden && !post.deleted_at && !post.user_deleted;
}

function sameBookUser(username, bot) {
  return typeof username === "string" && username.toLowerCase() === bot.toLowerCase();
}

function bookReplyIndex(topicId, reply, request, search) {
  if (!Number.isSafeInteger(reply.post_number) || !Number.isSafeInteger(reply.post_id)) return;
  return discourse.setCustomField("topic", topicId, bookReplyKey(reply.post_number),
    JSON.stringify({ id: reply.post_id, requestId: request.id, search }));
}

// Used by administrators to index pre-upgrade public replies with IDs obtained from the forum.
// Accepts no query or post text. Both ends of the existing reply link are checked in Discourse.
function indexLegacyBookReply(replyId, requestId) {
  const reply = discourse.getPost(replyId);
  const request = discourse.getPost(requestId);
  const bot = JSON.parse(secrets.get("book_account")).bot_username || "ZlibBot";
  if (!reply || !request || !visibleBookPost(reply, request.topic_id, reply.post_number) ||
      !sameBookUser(reply.username, bot) || !visibleBookPost(request, reply.topic_id, reply.reply_to_post_number) ||
      request.user_id <= 0 || sameBookUser(request.username, bot) || request.post_number >= reply.post_number)
    return "unmatched";
  const saved = discourse.getCustomField("topic", reply.topic_id, bookReplyKey(reply.post_number));
  if (saved) return "already indexed";
  const result = bookReplyIndex(reply.topic_id, { post_id: reply.id, post_number: reply.post_number }, request);
  return result && result.success ? "indexed" : "failed";
}

function previousBookSearch(request, reply, bot) {
  // Older releases only supported a single-line @bot title command. Never resolve a book via the network here.
  const mention = request.raw.trim().match(/^@([\w-]+)[\s:：,，]+([^\n]{1,260})$/i);
  if (!mention || !sameBookUser(mention[1], bot)) return null;
  const flags = parseBookSearchFlags(mention[2]);
  if (flags.error || !flags.query || /原帖|[這这][篇本文]|出[自處处]|哪本|original post|this (?:book|post)/i.test(flags.query))
    return null;
  const marked = markedBookTitles(flags.query);
  if (marked.length > 1) return null;
  const query = isbnOf(flags.query) || marked[0] || flags.query.replace(/^(?:搜[索尋寻]|找[書书]|找一下|(?:search(?:\s+for)?|find)\b)\s*/i, "").trim();
  if (!query || query.length > 200) return null;
  return { query, site: flags.site, page: flags.page || 1 };
}

function directBookParent(post, bot) {
  const number = post.reply_to_post_number;
  if (!Number.isSafeInteger(number) || number < 1 || number >= post.post_number) return null;
  const recipient = post.reply_to_user;
  if (recipient && recipient.username && !sameBookUser(recipient.username, bot)) return null;

  const saved = discourse.getCustomField("topic", post.topic_id, bookReplyKey(number));
  let entry;
  if (typeof saved === "string") {
    try { entry = JSON.parse(saved); } catch (_) { /* an unreadable index supplies no parent ID */ }
  }
  let id = entry && entry.id;
  if (!id && number === 1) {
    const topic = discourse.getTopic(post.topic_id);
    if (topic && topic.id === post.topic_id && topic.archetype === "regular") id = topic.first_post_id;
  }
  // reply_to_user comes from the serializer and can be omitted on quoted replies.
  if (!Number.isSafeInteger(id)) return recipient && sameBookUser(recipient.username, bot) ? {} : null;
  const parent = discourse.getPost(id);
  if (!visibleBookPost(parent, post.topic_id, number) || !sameBookUser(parent.username, bot) ||
      (recipient && Number.isInteger(recipient.id) && parent.user_id !== recipient.id)) return null;
  if (!entry || !Number.isSafeInteger(entry.requestId)) return {};
  const source = discourse.getPost(entry.requestId);
  if (!visibleBookPost(source, post.topic_id, parent.reply_to_post_number) ||
      source.post_number >= parent.post_number || !(source.user_id > 0) || sameBookUser(source.username, bot)) return {};
  return { search: entry.search || previousBookSearch(source, parent, bot) };
}

function directBookRequest(raw, parent) {
  const body = raw.replace(/\[quote(?:=[^\]]*)?\][\s\S]*?\[\/quote\]/gi, "")
    .replace(/^>[^\n]*$/gm, "").trim();
  const flags = parseBookSearchFlags(body);
  if (flags.error) return { op: "search", invalid: true };
  const command = flags.query;
  const previous = parent.search;
  const encouragement = /相信(?:你自己|自己|你)|加油|打[氣气]|別灰心|别灰心|you(?:'ve got this| can do it)|believe in yourself/i.test(command);
  const nudge = /^(?:[請请]?(?:[繼继][續续]|[繼继][續续]找|再[来來]|[幫帮]我(?:拿到|取得|找)|就[這这]本)|好(?:啊|的)?|[對对]|go ahead|yes(?: please)?|please do)(?:[。.!！?？\s]*)$/i.test(command);
  if (command.length <= 260 && !command.includes("\n")) {
    const format = command.match(/\b(epub|pdf|mobi|azw3|djvu|fb2|txt)\b/i) ||
      command.match(/(epub|pdf|mobi|azw3|djvu|fb2|txt)版/i);
    const marked = markedBookTitles(command);
    const isbn = isbnOf(command);
    const explicit = command.match(/^(?:(?:麻[煩烦]|[請请])\s*)?(?:(?:[幫帮]我)\s*)?(?:搜[尋寻索]|[檢检]索|找一下|找找|找|(?:please\s+)?(?:search(?:\s+for)?|find)\b)\s*[:：]?\s*(.+)$/i);
    const chinese = /中文(?:版|[譯译]本)?|中[譯译]本|\bin chinese\b/i.test(command);
    const retry = /再[試试找查搜來来]|重[試试查搜]|[換换](?:成|[個个]版本)|下[一页頁]|繼續|继续|try again|retry|next page|another edition/i.test(command);
    const byTitle = marked.length === 1 ? marked[0] : isbn;
    const subject = explicit && explicit[1].replace(/[。？?]$/, "").trim();
    const newQuery = byTitle || (!retry && !chinese && !format && !/[?？]/.test(command) && subject);
    const refine = !command || retry || chinese || format || encouragement || nudge;
    if (marked.length < 2 && (newQuery || (refine && previous && previous.query))) {
      const prior = newQuery ? {} : previous;
      let page = prior.page || 1;
      if (chinese || format) page = 1;
      if (/下[一]?[頁页]|next page/i.test(command)) page++;
      return { op: "search", query: newQuery || prior.query, page: flags.page || page,
        site: flags.site || prior.site, extension: format ? format[1].toLowerCase() : prior.extension,
        chinese: chinese || prior.chinese };
    }
  }
  const thanks = /[謝谢][謝谢]|多[謝谢]|感[謝谢]|\bthanks?\b|thank you/i.test(command);
  return { op: "reply", kind: encouragement ? "encouragement" : thanks ? "thanks" : "clarify", previous };
}

function publicEditionFor(query) {
  const key = value => bookKey(value.replace(/&/g, "and"));
  const editions = [{
    title: "Pride and Prejudice", author: "Jane Austen", authors: ["Jane Austen", "Austen, Jane"],
    language: "English", publisher: "Standard Ebooks",
    epub: "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub?source=download",
  }];
  return typeof query === "string" && editions.find(edition => key(query) === key(edition.title));
}

function samePublicEditionWork(row, edition) {
  const title = row.title.replace(/&/g, "and");
  const author = row.author.replace(/\s*\[[^\]]+\]\s*$/, "");
  return bookKey(title) === bookKey(edition.title) &&
    edition.authors.some(name => bookKey(name) === bookKey(author));
}
