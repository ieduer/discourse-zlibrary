import DButton from "discourse/ui-kit/d-button";
import { apiInitializer } from "discourse/lib/api";
import { i18n } from "discourse-i18n";
import BookLibrary from "../components/book-library";
import BookPostPages from "../components/book-post-pages";

function publishedBook(row) {
  const link = row.querySelector('a[href*="#zlibrary-edition-"]');
  const href = link && new URL(link.href, window.location.href);
  const match = href?.origin === window.location.origin && href.hash.match(/^#zlibrary-edition-(\d{1,15}\.\d+)-([a-z0-9]{1,12})$/);
  const caption = (link || row).textContent.trim().replace(/（未提供下載識別碼）$/, "");
  const parts = caption.split(" · ");
  let size = "";
  if (/^\d[\d.,]*\s*(?:[KMGT]i?B|B|bytes?)$/i.test(parts.at(-1))) size = parts.pop();
  const format = parts.length > 1 && /^[a-z0-9]{1,12}$/i.test(parts.at(-1)) &&
    (match ? parts.at(-1).toLowerCase() === match[2] : /^(epub|pdf|mobi|azw3|djvu|fb2|txt)$/i.test(parts.at(-1))) ? parts.pop() : "";
  return { title: parts.shift(), details: parts.join(" · "), extension: format, size, caption,
    href: match ? href.href : null, selection: match ? match[1] : null };
}

function decoratePages(element, helper, bot, group, openEdition) {
  if (!helper?.renderGlimmer || element.querySelector(":scope > .zlibrary-post-pager")) return;
  const paragraphs = [...element.querySelectorAll(":scope > p")];
  const heading = paragraphs.find(p => /^(?:「.+」的搜尋結果。|書庫在這一頁沒有傳回「.+」的結果。)/u.test(p.textContent));
  if (!heading) return;
  const title = heading.textContent.match(/「(.+)」的(?:搜尋)?結果/u)[1];
  const badge = paragraphs.find(p => /^第 \d+ 頁(?:，共 \d+ 頁)?。$/.test(p.textContent));
  const numbers = badge?.textContent.match(/\d+/g);
  const list = (badge || heading).nextElementSibling;
  const commands = [];
  for (const p of paragraphs) {
    const direction = p.textContent.match(/^(上|下)一頁可回覆：/u);
    if (!direction) continue;
    const command = p.querySelector("code")?.textContent.match(/^@([\w-]+) (.+?)(?: --site ([1-3]))?(?: --ext (epub|pdf|mobi|azw3|djvu|fb2|txt))? --page (\d+)$/i);
    if (command?.[1].toLowerCase() !== bot) continue;
    commands.push({ p, forward: direction[1] === "下", query: command[2], site: command[3], extension: command[4], page: Number(command[5]) });
  }
  const command = commands[0];
  if (!numbers && !command) return;
  const page = numbers ? Number(numbers[0]) : command.page + (command.forward ? -1 : 1);
  const total = Number(numbers?.[1]) || null;
  const filters = { query: title };
  if (command) {
    // The command keeps literal @ signs. The heading also keeps backticks.
    let pos = 0;
    filters.query = title.replace(/./gu, char => {
      if (char.charCodeAt(0) === 96) return char;
      const literal = command.query.slice(pos, pos + char.length);
      pos += char.length;
      return char === "＠" && literal === "@" ? literal : char;
    });
    if (command.site) filters.site = Number(command.site);
    if (command.extension) filters.extension = command.extension;
  }
  const host = document.createElement("div");
  host.className = "zlibrary-post-pager";
  const nativeList = list?.tagName === "OL" ? list : null;
  (commands.at(-1)?.p || nativeList || badge || heading).after(host);
  for (const p of [badge, ...commands.map(c => c.p)]) p?.classList.add("zlibrary-page-fallback");
  heading.classList.add("zlibrary-initial-results");
  nativeList?.classList.add("zlibrary-initial-results");
  const books = nativeList ? [...nativeList.querySelectorAll(":scope > li")].map(publishedBook) : [];
  const initial = { books, page, total_pages: total, has_next: total ? page < total : commands.some(c => c.forward) };
  helper.renderGlimmer(host, BookPostPages, { initial, filters, group, openEdition });
}

export default apiInitializer((api) => {
  const group = settings.book_inbox_group.trim();
  if (!api.getCurrentUser() || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,39}$/.test(group)) {
    return;
  }
  const modal = api.container.lookup("service:modal");
  const router = api.container.lookup("service:router");
  const currentTopic = () => /^topic(?:\.|$)/.test(router.currentRouteName || "")
    ? api.container.lookup("controller:topic")?.model : null;
  const open = () => modal.show(BookLibrary, { model: { group, topic: currentTopic() } });
  const bot = settings.book_bot_username.trim().toLowerCase();
  api.decorateCookedElement((element, helper) => {
    const post = helper?.getModel?.();
    if (!post || post.username?.toLowerCase() !== bot) return;
    const openEdition = (edition, conversation) => modal.show(BookLibrary, { model: {
      group, topic: post.topic || currentTopic(), sourceTopicId: post.topic_id, edition, conversation,
    } });
    decoratePages(element, helper, bot, group, openEdition);
    for (const link of element.querySelectorAll('a[href*="#zlibrary-edition-"]')) {
      const url = new URL(link.href, window.location.href);
      const edition = url.hash.match(/^#zlibrary-edition-(\d{1,15}\.\d+)-([a-z0-9]{1,12})$/);
      if (url.origin !== window.location.origin || !edition || link.dataset.zlibraryChoice) continue;
      link.dataset.zlibraryChoice = "true";
      link.addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        openEdition({ selection: edition[1], extension: edition[2], title: link.textContent.trim() });
      });
    }
  }, { id: "forum-book-library-choices", onlyStream: true });
  const label = i18n(themePrefix("zlibrary.title"));
  api.headerIcons.add(
    "forum-book-library",
    <template>
      <li>
        <DButton
          @action={{open}} @icon="book" @translatedTitle={{label}} @translatedAriaLabel={{label}}
          class="icon btn-flat zlibrary-open"
        />
      </li>
    </template>,
    { before: "search" }
  );
});
