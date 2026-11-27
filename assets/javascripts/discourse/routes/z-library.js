import { ajax } from "discourse/lib/ajax";
import DiscourseRoute from "discourse/routes/discourse";
import { i18n } from "discourse-i18n";

export default class ZLibraryRoute extends DiscourseRoute {
  model() {
    return ajax("/z-library.json");
  }

  titleToken() {
    return i18n("zlibrary.title");
  }
}
