import DButton from "discourse/ui-kit/d-button";
import { apiInitializer } from "discourse/lib/api";
import { i18n } from "discourse-i18n";
import BookLibrary from "../components/book-library";

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
    for (const link of element.querySelectorAll('a[href*="#zlibrary-edition-"]')) {
      const url = new URL(link.href, window.location.href);
      const edition = url.hash.match(/^#zlibrary-edition-(\d{1,15}\.\d+)-([a-z0-9]{1,12})$/);
      if (url.origin !== window.location.origin || !edition || link.dataset.zlibraryChoice) continue;
      link.dataset.zlibraryChoice = "true";
      link.addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        modal.show(BookLibrary, { model: {
          group, topic: post.topic || currentTopic(), sourceTopicId: post.topic_id,
          edition: { selection: edition[1], extension: edition[2], title: link.textContent.trim() }
        } });
      });
    }
  }, { id: "forum-book-library-choices" });
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
