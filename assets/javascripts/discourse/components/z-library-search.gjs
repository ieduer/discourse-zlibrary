import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { ajax, updateCsrfToken } from "discourse/lib/ajax";
import { extractError } from "discourse/lib/ajax-error";
import { deliverBlobDownload, MAX_BRIDGED_DOWNLOAD_BYTES } from "discourse/lib/download-blob";
import { attachmentDownloadStrategy } from "discourse/lib/download-strategy";
import getURL from "discourse/lib/get-url";
import Session from "discourse/models/session";
import { eq, not, or } from "discourse/truth-helpers";
import { i18n } from "discourse-i18n";

export default class ZLibrarySearch extends Component {
  @tracked result = null;
  @tracked selected = null;
  @tracked submitted = null;
  @tracked busy = null;
  @tracked error = "";
  @tracked notice = "";

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
      const result = await ajax("/z-library/search.json", {
        type: "POST",
        data: { ...filters, page },
      });
      this.result = result;
      this.submitted = filters;
    } catch (error) {
      this.error = extractError(error, i18n("zlibrary.search_error"));
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
    const book = this.selected;
    if (!book || this.busy) {
      return;
    }
    this.notice = "";
    this.error = "";
    const inHub = attachmentDownloadStrategy() === "bridge";
    if (inHub && book.bytes > MAX_BRIDGED_DOWNLOAD_BYTES) {
      this.error = i18n("zlibrary.hub_limit");
      return;
    }
    if (book.bytes > this.args.settings.max_mb * 1024 * 1024) {
      this.error = i18n("zlibrary.file_limit", { limit: this.args.settings.max_mb });
      return;
    }
    this.busy = "download";
    try {
      if (!Session.currentProp("csrfToken")) {
        await updateCsrfToken();
      }
      const response = await fetch(getURL("/z-library/download"), {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": Session.currentProp("csrfToken"),
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({ selection: book.selection, hub: inHub }),
      });
      const disposition = response.headers.get("Content-Disposition");
      if (!response.ok || !disposition?.toLowerCase().startsWith("attachment")) {
        const problem = await response.json().catch(() => null);
        this.error = problem?.errors?.[0] || i18n("zlibrary.download_error");
        return;
      }
      await deliverBlobDownload(await response.blob(), {
        fallbackFilename: book.title,
        contentDisposition: disposition,
      });
      this.notice = i18n("zlibrary.download_sent", { title: book.title });
    } catch {
      this.error = i18n("zlibrary.download_error");
    } finally {
      this.busy = null;
    }
  }

  <template>
    <section class="zlibrary" aria-labelledby="zlibrary-title">
      <h1 id="zlibrary-title">{{i18n "zlibrary.title"}}</h1>
      <form class="zlibrary__search" {{on "submit" this.search}}>
        <label class="zlibrary__query">
          <span>{{i18n "zlibrary.query"}}</span>
          <input type="search" name="query" required maxlength="200" disabled={{this.busy}} />
        </label>
        <label>
          <span>{{i18n "zlibrary.format"}}</span>
          <select name="extension" disabled={{this.busy}}>
            <option value="">{{i18n "zlibrary.any_format"}}</option>
            {{#each @settings.formats as |format|}}
              <option value={{format}}>{{format}}</option>
            {{/each}}
          </select>
        </label>
        <button type="submit" class="btn btn-primary" disabled={{this.busy}}>
          {{i18n "zlibrary.search"}}
        </button>
      </form>

      <div role="status" class="zlibrary__message">
        {{#if (eq this.busy "search")}}{{i18n "zlibrary.searching"}}{{/if}}
      </div>
      {{#if (not this.selected)}}
        {{#if this.error}}<p class="alert alert-error" role="alert">{{this.error}}</p>{{/if}}
      {{/if}}

      {{#if this.result}}
        <fieldset class="zlibrary__results" disabled={{this.busy}}>
          <legend>{{i18n "zlibrary.results" query=this.submitted.query}}</legend>
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
                >{{i18n "zlibrary.download"}}</button>
                <span role="status">
                  {{#if (eq this.busy "download")}}{{i18n "zlibrary.downloading"}}{{/if}}
                  {{this.notice}}
                </span>
                {{#if this.error}}<p class="alert alert-error" role="alert">{{this.error}}</p>{{/if}}
              </div>
            {{/if}}
          {{else}}
            <p>{{i18n "zlibrary.no_results"}}</p>
          {{/each}}
        </fieldset>
        {{#if (or this.result.has_next (not (eq this.result.page 1)))}}
        <nav class="zlibrary__pages" aria-label={{i18n "zlibrary.pages"}}>
          <button
            class="btn btn-default"
            type="button"
            disabled={{or this.busy (eq this.result.page 1)}}
            {{on "click" (fn this.changePage -1)}}
          >{{i18n "zlibrary.previous"}}</button>
          <span>
            {{#if this.result.total_pages}}
              {{i18n "zlibrary.page_of" page=this.result.page total=this.result.total_pages}}
            {{else}}
              {{i18n "zlibrary.page" page=this.result.page}}
            {{/if}}
          </span>
          <button
            class="btn btn-default"
            type="button"
            disabled={{or this.busy (not this.result.has_next)}}
            {{on "click" (fn this.changePage 1)}}
          >{{i18n "zlibrary.next"}}</button>
        </nav>
        {{/if}}
      {{/if}}
    </section>
  </template>
}
