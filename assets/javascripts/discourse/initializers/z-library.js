import { apiInitializer } from "discourse/lib/api";
import { i18n } from "discourse-i18n";

export default apiInitializer((api) => {
  if (!api.getCurrentUser() || !api.container.lookup("service:site-settings").zlibrary_enabled) {
    return;
  }
  api.addCommunitySectionLink(
    {
      name: "z-library",
      route: "z-library",
      title: i18n("zlibrary.title"),
      text: i18n("zlibrary.title"),
      icon: "book-open",
    },
    true
  );
});
