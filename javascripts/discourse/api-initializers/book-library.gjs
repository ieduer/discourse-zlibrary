import DButton from "discourse/ui-kit/d-button";
import { apiInitializer } from "discourse/lib/api";
import { i18n } from "discourse-i18n";
import BookLibrary from "../components/book-library";

export default apiInitializer((api) => {
  const path = settings.book_service_path.trim();
  if (!api.getCurrentUser() || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path)) {
    return;
  }
  const modal = api.container.lookup("service:modal");
  const open = () => modal.show(BookLibrary, { model: { path } });
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
