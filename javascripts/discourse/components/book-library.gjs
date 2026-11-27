import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import DModal from "discourse/ui-kit/d-modal";
import { deliverBlobDownload, MAX_BRIDGED_DOWNLOAD_BYTES } from "discourse/lib/download-blob";
import { attachmentDownloadStrategy } from "discourse/lib/download-strategy";
import { eq, not, or } from "discourse/truth-helpers";
import { i18n } from "discourse-i18n";

const t = (key, options) => i18n(themePrefix(`zlibrary.${key}`), options);
const knownErrors = new Set(["configuration", "account", "verification", "upstream", "timeout", "unavailable", "quota", "rate_limited", "too_large", "incomplete", "selection", "query", "membership", "file_host"]);

export default class BookLibrary extends Component {
  formats = ["epub", "pdf", "mobi", "azw3", "djvu", "fb2", "txt"];
  @tracked result = null;
  @tracked selected = null;
  @tracked submitted = null;
  @tracked busy = null;
  @tracked error = "";
  @tracked notice = "";

  async request(operation, data) {
    const response = await fetch(`${this.args.model.path}/${operation}`, {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Zlibrary-Request": "1" },
      body: JSON.stringify(data),
    });
    if (response.ok) {
      return response;
    }
    const problem = await response.json().catch(() => null);
    const key = knownErrors.has(problem?.error) ? problem.error : "configuration";
    throw new Error(t(`errors.${key}`, { limit: problem?.limit ?? 128 }));
  }

  @action
  search(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const query = data.get("query").trim();
    if (!query || this.busy) {
      return;
    }
    this.result = null;
    return this.loadPage({ query, extension: data.get("extension") }, 1);
  }

  @action
  changePage(offset) {
    if (!this.busy && this.result) {
      return this.loadPage(this.submitted, this.result.page + offset);
    }
  }

  async loadPage(filters, page) {
    this.busy = "search";
    this.selected = null;
    this.notice = "";
    this.error = "";
    try {
      const response = await this.request("search", { ...filters, page });
      if (!response.headers.get("Content-Type")?.includes("application/json")) {
        throw new Error(t("errors.configuration"));
      }
      const result = await response.json();
      if (!Array.isArray(result.books)) {
        throw new Error(t("errors.upstream"));
      }
      this.submitted = filters;
      this.result = result;
    } catch (error) {
      this.error = error instanceof TypeError ? t("search_error") : error.message;
    } finally {
      this.busy = null;
    }
  }

  @action
  choose(book) {
    this.selected = book;
    this.error = "";
    this.notice = "";
  }

  @action
  async download() {
    if (!this.selected || this.busy) {
      return;
    }
    const book = this.selected;
    const hub = attachmentDownloadStrategy() === "bridge";
    if (hub && book.bytes > MAX_BRIDGED_DOWNLOAD_BYTES) {
      this.error = t("hub_limit");
      return;
    }
    this.busy = "download";
    this.error = "";
    this.notice = "";
    try {
      const response = await this.request("download", { selection: book.selection, hub });
      const disposition = response.headers.get("Content-Disposition");
      if (!disposition?.toLowerCase().startsWith("attachment;")) {
        throw new Error(t("errors.configuration"));
      }
      await deliverBlobDownload(await response.blob(), {
        contentDisposition: disposition, fallbackFilename: book.title,
      });
      this.notice = t("download_sent", { title: book.title });
    } catch (error) {
      this.error = error instanceof TypeError ? t("download_error") : error.message;
    } finally {
      this.busy = null;
    }
  }

  <template>
    <DModal @title={{t "title"}} @closeModal={{@closeModal}} class="zlibrary-modal">
      <:body>
        <section class="zlibrary">
          <form class="zlibrary__search" {{on "submit" this.search}}>
            <label class="zlibrary__query">
              <span>{{t "query"}}</span>
              <input type="search" name="query" required maxlength="200" disabled={{this.busy}} />
            </label>
            <label>
              <span>{{t "format"}}</span>
              <select name="extension" disabled={{this.busy}}>
                <option value="">{{t "any_format"}}</option>
                {{#each this.formats as |format|}}
                  <option value={{format}}>{{format}}</option>
                {{/each}}
              </select>
            </label>
            <button type="submit" class="btn btn-primary" disabled={{this.busy}}>
              {{t "search"}}
            </button>
          </form>

          <div role="status" class="zlibrary__message">
            {{#if (eq this.busy "search")}}{{t "searching"}}{{/if}}
          </div>
          {{#if (not this.selected)}}
            {{#if this.error}}<p class="alert alert-error" role="alert">{{this.error}}</p>{{/if}}
          {{/if}}

          {{#if this.result}}
            <fieldset class="zlibrary__results" disabled={{this.busy}}>
              <legend>{{t "results" query=this.submitted.query}}</legend>
              {{#each this.result.books key="selection" as |book|}}
                <label class="zlibrary__book">
                  <input
                    type="radio"
                    name="zlibrary-edition"
                    checked={{eq this.selected.selection book.selection}}
                    {{on "change" (fn this.choose book)}}
                  />
                  <span class="zlibrary__record">
                    <strong>{{book.title}}</strong>
                    {{#if book.author}}<span>{{book.author}}</span>{{/if}}
                    <span class="zlibrary__metadata">
                      {{#if book.publisher}}<span>{{book.publisher}}</span>{{/if}}
                      {{#if book.year}}<span>{{book.year}}</span>{{/if}}
                      {{#if book.language}}<span>{{book.language}}</span>{{/if}}
                      {{#if book.extension}}<span class="zlibrary__format">{{book.extension}}</span>{{/if}}
                      {{#if book.size}}<span>{{book.size}}</span>{{/if}}
                    </span>
                  </span>
                </label>
                {{#if (eq this.selected.selection book.selection)}}
                  <div class="zlibrary__download">
                    <button
                      class="btn btn-primary"
                      type="button"
                      disabled={{this.busy}}
                      {{on "click" this.download}}
                    >{{t "download"}}</button>
                    <span role="status">
                      {{#if (eq this.busy "download")}}{{t "downloading"}}{{/if}}
                      {{this.notice}}
                    </span>
                    {{#if this.error}}<p class="alert alert-error" role="alert">{{this.error}}</p>{{/if}}
                  </div>
                {{/if}}
              {{else}}
                <p>{{t "no_results"}}</p>
              {{/each}}
            </fieldset>
            {{#if (or this.result.has_next (not (eq this.result.page 1)))}}
            <nav class="zlibrary__pages" aria-label={{t "pages"}}>
              <button
                class="btn btn-default"
                type="button"
                disabled={{or this.busy (eq this.result.page 1)}}
                {{on "click" (fn this.changePage -1)}}
              >{{t "previous"}}</button>
              <span>
                {{#if this.result.total_pages}}
                  {{t "page_of" page=this.result.page total=this.result.total_pages}}
                {{else}}
                  {{t "page" page=this.result.page}}
                {{/if}}
              </span>
              <button
                class="btn btn-default"
                type="button"
                disabled={{or this.busy (not this.result.has_next)}}
                {{on "click" (fn this.changePage 1)}}
              >{{t "next"}}</button>
            </nav>
            {{/if}}
          {{/if}}
        </section>
      </:body>
    </DModal>
  </template>
}
