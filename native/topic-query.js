// The Discourse tool runner exposes these functions to invoke() in the same script.
function bookKey(value) {
  return (value || "").normalize("NFKC").toLowerCase().replace(/[\s·・.,，。、:：_'"’\-]/g, "");
}

function markedBookTitles(value) {
  return Array.from(new Set(Array.from(value.matchAll(/《([^《》\n]{1,120})》/g), (m) => m[1].trim())));
}

function isbnOf(value) {
  const match = value.match(/(?:^|\bISBN(?:-1[03])?\s*[:：]?\s*)((?:97[89][\s-]*)?(?:\d[\s-]*){9}[\dX])(?=$|[^\dX])/i);
  if (!match) return "";
  const digits = match[1].replace(/[\s-]/g, "").toUpperCase();
  if (digits.length === 13 && /^97[89]\d{10}$/.test(digits)) {
    return Array.from(digits).reduce((sum, d, i) => sum + Number(d) * (i % 2 ? 3 : 1), 0) % 10 === 0 ? digits : "";
  }
  if (digits.length === 10) {
    return Array.from(digits).reduce((sum, d, i) => sum + (d === "X" ? 10 : Number(d)) * (10 - i), 0) % 11 === 0 ? digits : "";
  }
  return "";
}

var documentedCollections = [{
  stories: ["盐", "鹽", "Salt", "Соль"],
  authors: ["伊萨克·巴别尔", "伊薩克·巴別爾", "巴别尔", "巴別爾", "Isaac Babel", "Isaak Babel", "Babel, Isaac"],
  titles: ["骑兵军", "红色骑兵军", "騎兵軍", "紅色騎兵軍", "Red Cavalry", "Конармия"],
  catalogAuthors: ["巴别尔", "巴別爾", "Babel", "Бабель"],
  citation: "伊萨克·巴别尔的短篇〈盐〉收在《骑兵军》（Red Cavalry）里。英文版目录把〈盐〉列为 Salt。[英文版目录](https://www.abebooks.com/9781782270935/Red-Cavalry-Pushkin-Collection-Isaac-1782270930/plp)",
  translations: [{
    names: ["戴骢", "戴驄"],
    citation: "帖子标注的译者是戴骢。戴骢译本有人民文学出版社 2004 年出版的《骑兵军》，也有浙江文艺出版社 2003 年出版的《红色骑兵军》。仅凭帖末署名无法确定摘录采用了哪一版。[巴别尔作品书目，第 23 页](https://web.stanford.edu/group/isaac_babel/bibliography/works_and_criticism.pdf#page=23)",
  }],
}];

function publicPostByNumber(topicId, number) {
  try {
    const result = http.get(discourse.baseUrl + "/posts/by_number/" + topicId + "/" + number + ".json", {
      headers: { Accept: "application/json" },
    });
    if (result.status !== 200 || typeof result.body !== "string" || result.body.length > 1500000) return null;
    const entry = JSON.parse(result.body);
    return entry.topic_id === topicId && entry.post_number === number && entry.post_type === 1 &&
      !entry.hidden && !entry.deleted_at && !entry.user_deleted ? entry : null;
  } catch (_) { return null; }
}

function bookContextPost(post, command) {
  const topic = discourse.getTopic(post.topic_id);
  if (!topic || topic.id !== post.topic_id || topic.archetype !== "regular") return null;
  const number = /原帖|首[帖樓楼]|主帖|original post/i.test(command) ? 1 : post.reply_to_post_number || 1;
  let source;
  if (number === 1 && Number.isSafeInteger(topic.first_post_id)) {
    source = discourse.getPost(topic.first_post_id);
  } else if (Number.isSafeInteger(number) && number > 1 && number < post.post_number) {
    // getPost takes a global ID, while a reply carries only its topic-relative post number.
    // This same-site endpoint enforces the anonymous reader's permissions. Send no session.
    const entry = publicPostByNumber(topic.id, number);
    if (entry && Number.isSafeInteger(entry.id)) source = discourse.getPost(entry.id);
  }
  if (!source || source.topic_id !== topic.id || source.post_number !== number ||
      source.post_type !== 1 || source.hidden || source.deleted_at || source.user_deleted ||
      typeof source.raw !== "string" || source.id === post.id) return null;
  return { raw: source.raw, title: number === 1 ? topic.title : "", topicId: topic.id, number, id: source.id };
}

function wikidataCollection(story, author, source, preferChinese) {
  // Only an anonymously readable post's title and explicitly identified author may enter this query.
  if (!story || story.length > 100 || /[<>@\n\[\]{}?？]/.test(story) ||
      !/^[\p{L}\p{M}][\p{L}\p{M}'’·. ,-]{0,69}$/u.test(author)) return null;
  if (source.number === 1) {
    const publicEntry = publicPostByNumber(source.topicId, 1);
    if (!publicEntry || publicEntry.id !== source.id) return null;
  }
  const languages = ["en", "zh", "zh-hans", "zh-hant", "ru", "fr", "de", "es"];
  const names = (value) => languages.map(lang => JSON.stringify(value) + "@" + lang).join(" ");
  const labelLanguages = preferChinese ? "zh-hans,zh,zh-hant,en,ru,fr,de,es" : languages.join(",");
  const sparql = "SELECT DISTINCT ?work ?creator ?collection (STR(?storyLabel) AS ?workName)" +
    " (STR(?writerLabel) AS ?writerName) ?collectionLabel WHERE {" +
    " VALUES ?storyLabel { " + names(story) + " } VALUES ?writerLabel { " + names(author) + " }" +
    " ?work (rdfs:label|skos:altLabel) ?storyLabel; wdt:P50 ?creator; (wdt:P361|wdt:P1433|^wdt:P527) ?collection." +
    " ?creator (rdfs:label|skos:altLabel) ?writerLabel." +
    " VALUES ?bookType { wd:Q571 wd:Q1279564 wd:Q105420 }" +
    " ?collection (wdt:P31|wdt:P7937)/wdt:P279* ?bookType." +
    " SERVICE wikibase:label { bd:serviceParam wikibase:language " + JSON.stringify(labelLanguages) + ". } } LIMIT 2";
  try {
    const result = http.get("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql),
      { headers: { Accept: "application/sparql-results+json", "User-Agent": "DiscourseBookLibrary/3.2 (" + discourse.baseUrl + ")" } });
    if (result.status !== 200 || typeof result.body !== "string" || result.body.length > 65536) return null;
    const rows = JSON.parse(result.body).results.bindings;
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const first = rows[0];
    const entity = /^https?:\/\/www\.wikidata\.org\/entity\/(Q[1-9]\d*)$/;
    if (![first.work, first.creator, first.collection].every(item => item && entity.test(item.value)) ||
        bookKey(first.writerName.value) !== bookKey(author) || bookKey(first.workName.value) !== bookKey(story)) return null;
    const title = first.collectionLabel.value;
    if (typeof title !== "string" || !title.trim() || title.length > 150 || /^Q\d+$/.test(title)) return null;
    return { query: title, titles: [title], authors: [author], story, author,
      citationUrl: "https://www.wikidata.org/wiki/" + first.work.value.match(entity)[1] };
  } catch (_) { return null; }
}

function bookFromPost(source, identify, command) {
  if (!source) return { query: "", identify };
  // Bounded excerpts cover title/credit lines of long posts. The body stays in Discourse.
  const body = source.raw.length <= 12000 ? source.raw : source.raw.slice(0, 6000) + "\n\n" + source.raw.slice(-6000);
  const lines = body.replace(/<br\s*\/?\s*>|<\/p>/gi, "\n").replace(/<[^>\n]{1,200}>/g, "").replace(/\*\*/g, "");
  function field(names) {
    const match = lines.match(new RegExp("(?:^|\\n)[ \\t#>*-]*(?:" + names + ")[ \\t]*[:：][ \\t]*([^\\n]{1,150})", "i"));
    return match ? match[1].replace(/^\s*(?:\[[^\]]{1,8}\]|【[^】]{1,8}】|[（(][^）)]{1,8}[）)])\s*/, "")
      .replace(/\s*[【\[（(]\s*\d{4}[^\n]*$/, "").trim() : "";
  }
  const author = field("作者|著者|author");
  const translator = field("译者|譯者|translator");
  const book = field("书名|書名|book title");
  const containers = Array.from(new Set(Array.from(lines.matchAll(/(?:选自|選自|节选自|節選自|摘自|出自|收[录錄]于|收[录錄]於|收在|[收选選]入)\s*[:：]?\s*《([^《》\n]{1,120})》/g), m => m[1].trim())));
  const title = (source.title || "").trim();
  const story = field("篇名|篇目|story title") || (markedBookTitles(title)[0] || title).replace(/^[〈「]|[〉」]$/g, "");
  const requestedWorks = markedBookTitles(command);
  if (requestedWorks.length && (requestedWorks.length !== 1 || bookKey(requestedWorks[0]) !== bookKey(story))) return { query: "", identify };
  const isbn = isbnOf(lines);
  const explicit = markedBookTitles(book)[0] || book;
  const quoted = markedBookTitles(title);
  // A source-identification question needs an explicit collection, not just a story title.
  if (containers.length > 1) return { query: "", identify };
  if (!containers.length && !explicit && !isbn) {
    const known = documentedCollections.find(entry => entry.stories.some(name => bookKey(name) === bookKey(story)) &&
      entry.authors.some(name => bookKey(name) === bookKey(author)));
    if (known) return { query: known.titles[0], titles: known.titles, authors: known.catalogAuthors, translator,
      chinese: /[\u3400-\u9fff]/.test(story + author), identify: true, known };
    if (identify || field("篇名|篇目|story title")) {
      const found = wikidataCollection(story, author, source, /中文|中[譯译]/.test(command) || /[\u3400-\u9fff]/.test(story));
      return found ? Object.assign(found, { identify: true, translator, chinese: /中文|中[譯译]/.test(command) }) : { query: "", identify: true };
    }
  }
  let target = containers[0] || explicit;
  if (!target && !isbn && !identify) {
    const mentions = quoted.length ? quoted : markedBookTitles(lines);
    if (mentions.length === 1) target = mentions[0];
    else if (!mentions.length && title && title.length <= 80 && !/[?!？！，。]/.test(title) &&
        !/求[书書]|书[单單]|書單|[討讨][論论]|[讀读][書书]分享|book discussion/i.test(title)) target = title;
  }
  return { query: isbn || target || "", titles: target ? [target] : [], authors: author ? [author] : [],
    translator, chinese: /中文|中[譯译]/.test(command), identify, container: containers[0] || "" };
}

function resolveTopicBook(post, command) {
  const identify = /出[自處处]|[来來]自哪|[收選选摘節节]自哪|[收選选]([錄录入在於于]|在哪)|哪(?:一)?本[书書]|which book|what book|source of/i.test(command);
  const marked = markedBookTitles(command);
  const reference = /[這这那本原上][篇帖子文]|[這这那]本[书書]|[此該该][篇文書书]|[這这]部|樓[主上]|楼[主上]|主[帖楼樓]|首[帖楼樓]|this (?:book|story|post)|original post/i.test(command);
  if (identify || (!marked.length && (!command || reference ||
      /^(?:[請请]?(?:幫|帮)?(?:我)?(?:找書|找书|找一下|找找)|find (?:it|this))\s*[?？。!！]?$/i.test(command)))) {
    return bookFromPost(bookContextPost(post, command), identify, command);
  }
  if (marked.length > 1) return { query: "" };
  const isbn = isbnOf(command);
  if (isbn) return { query: isbn };
  if (marked.length) return { query: marked[0] };
  const query = command.replace(/^(?:(?:麻[煩烦]|[請请])\s*)?(?:(?:[幫帮]我)\s*)?(?:搜[尋寻索]|[檢检]索|找[書书]|找一下|找找|找|(?:please\s+)?(?:search(?:\s+for)?|find)\b)[\s:：]*/i, "")
    .replace(/(?:[好可]?[嗎吗][？?]?|[。？?])$/, "").trim();
  return { query };
}

function contextualEditions(rows, book) {
  if (!book || !book.titles) return rows.sort((a, b) => Number(b.extension === "epub") - Number(a.extension === "epub"));
  function titleMatches(title, target) {
    const key = bookKey(target);
    return bookKey(title.split(/[（(\[【:：=／/]/)[0]) === key || bookKey(title) === key;
  }
  function preference(row) {
    const credits = bookKey(row.translator + " " + row.author);
    const translators = /戴[骢驄]/.test(book.translator) ? ["戴骢", "戴驄", "daicong"] : [bookKey(book.translator)];
    const hasCredit = translators.some(name => name && credits.includes(name));
    const chinese = /chinese|中文|汉语|漢語|^zh\b|^chi$|^zho$/i.test(row.language);
    return (hasCredit ? 4 : 0) + (book.chinese && chinese ? 2 : 0) + (row.extension === "epub" ? 1 : 0);
  }
  return rows.filter(row => (!book.titles.length || book.titles.some(name => titleMatches(row.title, name))) &&
      (!book.authors.length || book.authors.some(name => bookKey(row.author).includes(bookKey(name)))))
    .sort((a, b) => preference(b) - preference(a));
}
