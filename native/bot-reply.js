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
    JSON.stringify({ id: reply.post_id, requestId: request.id, literalVersion: search ? 1 : undefined, search }));
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

function previousBookSearch(source, bot) {
  const mention = source.raw.trim().match(/^@([\w-]+)(?=$|[\s:：,，])[\s:：,，]*([^\n]{0,260})$/i);
  if (!mention || !sameBookUser(mention[1], bot)) return null;
  const flags = parseBookSearchFlags(mention[2]);
  if (flags.error) return null;
  const keyword = resolveTopicBook(source, flags.query);
  return keyword.query ? { ...keyword, page: flags.page || 1, site: flags.site } : null;
}

function directBookParent(post, bot, depth = 0) {
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
  if (entry.literalVersion === 1 && typeof entry.search?.query === "string") return { search: entry.search };
  // Pre-upgrade search.query may have been inferred. Re-read the member's actual words.
  const original = previousBookSearch(source, bot);
  if (original) return { search: original };
  if (depth < 5) {
    const earlier = directBookParent(source, bot, depth + 1);
    if (earlier) {
      const previous = directBookRequest(source.raw, earlier);
      if (previous.op === "search" && previous.query) return { search: { query: previous.query, page: previous.page,
        extension: previous.extension, site: previous.site } };
    }
  }
  return {};
}

function directBookRequest(raw, parent) {
  const body = raw.replace(/\[quote(?:=[^\]]*)?\][\s\S]*?\[\/quote\]/gi, "")
    .replace(/^>[^\n]*$/gm, "").trim();
  const flags = parseBookSearchFlags(body);
  if (flags.error) return { op: "search", invalid: true };
  const command = flags.query;
  const previous = parent.search;
  const encouragement = /相信(?:你自己|自己|你)|加油|打[氣气]|別灰心|别灰心|you(?:'ve got this| can do it)|believe in yourself/i.test(command);
  const next = /^(?:下(?:一)?[頁页]|next page)[。.!！?？\s]*$/i.test(command);
  const retry = /^(?:(?:[請请]|please)\s*)?(?:[繼继][續续](?:找)?|再(?:找|查|搜|[試试]|[來来])(?:一次|一下)?|重[試试]|就[這这]本|好[啊的]?|[對对]|retry|try again|go ahead|yes(?: please)?)[。.!！?？\s]*$/i.test(command);
  const thanks = /^(?:[謝谢][謝谢]|多[謝谢]|感[謝谢]|thanks?|thank you)[。.!！\s]*$/i.test(command);
  if (thanks) return { op: "reply", kind: "thanks", previous };
  const filter = command.match(/^(?:(?:可以|請|请|[幫帮]我|要|找|換成|换成)\s*)*(epub|pdf|mobi|azw3|djvu|fb2|txt)\s*(?:格式|版(?:本)?)?\s*(?:[好可]?[嗎吗])?[。.!！?？\s]*$/i);
  if (!command || next || retry || encouragement || filter) {
    if (previous?.query) return { op: "search", query: previous.query, site: flags.site || previous.site,
      page: flags.page || (filter ? 1 : (previous.page || 1) + (next ? 1 : 0)),
      extension: filter ? filter[1].toLowerCase() : previous.extension };
    return { op: "reply", kind: encouragement ? "encouragement" : "clarify", previous };
  }
  const book = literalBookKeyword(command);
  if (book.query && !command.startsWith("@") && !/^(?:[這这]是什[麼么]意思|what do you mean)/i.test(command))
    return { op: "search", query: book.query, site: flags.site, page: flags.page || 1, extension: book.extension };
  return { op: "reply", kind: "clarify", previous };
}
