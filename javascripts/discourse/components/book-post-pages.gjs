import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { extractError } from "discourse/lib/ajax-error";
import { eq, not, or } from "discourse/truth-helpers";
import BookConversation, { t } from "../lib/book-conversation";

function details(book) {
  return book.details || [book.author, book.translator && t("translator", { name: book.translator }),
    book.publisher, book.year, book.language].filter(Boolean).join(" · ");
}

const Edition = <template>
  <span class="zlibrary__edition-text">
    <strong>{{if @book.title @book.title (t "untitled")}}</strong>
    {{#if (details @book)}}<span class="zlibrary__edition-details">{{details @book}}</span>{{/if}}
  </span>
  <span class="zlibrary__edition-file">
    {{#if @book.extension}}<span class="zlibrary__edition-format">{{@book.extension}}</span>{{/if}}
    {{#if @book.size}}<span>{{@book.size}}</span>{{/if}}
    {{#unless @book.selection}}<span>{{t "no_download"}}</span>{{/unless}}
  </span>
</template>;

export default class BookPostPages extends Component {
  @tracked result = null;
  @tracked loading = false;
  @tracked error = "";

  constructor(owner, args) {
    super(owner, args);
    this.conversation = new BookConversation(args.data.group);
  }

  get current() {
    return this.result || this.args.data.initial;
  }

  @action
  async turn(step) {
    if (this.loading || (step < 0 ? this.current.page <= 1 : !this.current.has_next)) return;
    const page = this.current.page + step;
    const active = () => !this.isDestroying && !this.isDestroyed;
    this.loading = true;
    this.error = "";
    try {
      const result = await this.conversation.request("search", { ...this.args.data.filters, page }, active);
      if (!Array.isArray(result?.books) || !Number.isInteger(result.page) || result.page < 1) {
        throw new Error(t("errors.upstream"));
      }
      if (active()) this.result = result;
    } catch (error) {
      if (active()) this.error = error instanceof Error ? error.message : extractError(error, t("search_error"));
    } finally {
      if (active()) this.loading = false;
    }
  }

  @action
  choose(book, event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const replay = book.href ? { filters: this.args.data.filters, page: this.current.page, caption: book.caption } : null;
    this.args.data.openEdition({ ...book, extension: book.extension?.toLowerCase(), replay }, this.conversation);
  }

  <template>
    <section class="zlibrary__catalog {{if this.result 'zlibrary__inline-results'}}">
      <h3>{{@data.filters.query}}</h3>
      {{#if this.current.books.length}}
        <ol class="zlibrary__shelf">
          {{#each this.current.books key="@index" as |book|}}
            <li>
              {{#if book.href}}
                <a class="zlibrary__edition" href={{book.href}} {{on "click" (fn this.choose book)}}><Edition @book={{book}} /></a>
              {{else if book.selection}}
                <button type="button" class="zlibrary__edition" {{on "click" (fn this.choose book)}}><Edition @book={{book}} /></button>
              {{else}}
                <div class="zlibrary__edition zlibrary__edition--unavailable"><Edition @book={{book}} /></div>
              {{/if}}
            </li>
          {{/each}}
        </ol>
      {{else}}
        <p>{{t "no_results"}}</p>
      {{/if}}
    </section>
    <nav class="zlibrary__pages zlibrary__post-nav" aria-label={{t "pages"}}>
      <button type="button" class="btn btn-default zlibrary-previous" disabled={{or this.loading (eq this.current.page 1)}} {{on "click" (fn this.turn -1)}}>{{t "previous"}}</button>
      <span role="status" aria-atomic="true">
        {{#if this.loading}}
          {{t "searching"}}
        {{else if this.current.total_pages}}
          {{t "page_of" page=this.current.page total=this.current.total_pages}}
        {{else}}
          {{t "page" page=this.current.page}}
        {{/if}}
      </span>
      <button type="button" class="btn btn-default zlibrary-next" disabled={{or this.loading (not this.current.has_next)}} {{on "click" (fn this.turn 1)}}>{{t "next"}}</button>
    </nav>
    {{#if this.error}}<p class="alert alert-error" role="alert">{{this.error}}</p>{{/if}}
  </template>
}
