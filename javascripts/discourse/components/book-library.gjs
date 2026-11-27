import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import DModal from "discourse/ui-kit/d-modal";
import { ajax } from "discourse/lib/ajax";
import { extractError } from "discourse/lib/ajax-error";
import getURL from "discourse/lib/get-url";
import { eq, not, or } from "discourse/truth-helpers";
import { i18n } from "discourse-i18n";

const t = (key, options) => i18n(themePrefix(`zlibrary.${key}`), options);
const knownErrors = new Set(["configuration", "account", "verification", "upstream", "unavailable", "quota", "rate_limited", "incomplete", "selection", "query", "attachment", "pending"]);

function replyPayload(post) {
  if (post.user_id !== -1) return null;
  const doc = new DOMParser().parseFromString(post.cooked || "", "text/html");
  const code = doc.querySelector("pre code");
  if (!code) return null;
  try { return JSON.parse(code.textContent); } catch { return null; }
}

export default class BookLibrary extends Component {
  topicId = null;
  @tracked readyFile = null;
  formats = ["epub", "pdf", "mobi", "azw3", "djvu", "fb2", "txt"];
  @tracked result = null;
  @tracked selected = null;
  @tracked submitted = null;
  @tracked busy = null;
  @tracked error = "";
  @tracked notice = "";

  async request(operation, fields) {
    const nonce = crypto.randomUUID();
    const raw = "book-library-request-v1\n" + JSON.stringify({ op: operation, nonce, ...fields });
    const target = this.topicId
      ? { topic_id: this.topicId }
      : { archetype: "private_message", target_recipients: this.args.model.group,
          title: t("pm_title") + " " + nonce.slice(0, 13) };
    const created = await ajax("/posts.json", { type: "POST", data: { ...target, raw } });
    const sent = created.post || created;
    if (!sent.topic_id || !sent.post_number) throw new Error(t("errors.pending"));
    this.topicId = sent.topic_id;
    const deadline = Date.now() + 90000;
    let delay = 600;
    while (Date.now() < deadline && !this.isDestroying && !this.isDestroyed) {
      const page = await ajax(`/t/${sent.topic_id}/posts.json`, {
        data: { post_number: sent.post_number, asc: true },
      });
      for (const post of page.post_stream?.posts || []) {
        if (post.reply_to_post_number !== sent.post_number) continue;
        const packet = replyPayload(post);
        if (packet?.marker !== "book-library-result-v1" || packet.nonce !== nonce) continue;
        if (packet.result?.error) {
          const key = knownErrors.has(packet.result.error) ? packet.result.error : "upstream";
          throw new Error(t("errors." + key));
        }
        return packet.result;
      }
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      delay = Math.min(delay + 600, 4000);
    }
    throw new Error(t("errors.pending"));
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
    this.readyFile = null;
    this.notice = "";
    this.error = "";
    try {
      const result = await this.request("search", { ...filters, page });
      if (!Array.isArray(result.books)) {
        throw new Error(t("errors.upstream"));
      }
      this.submitted = filters;
      this.result = result;
    } catch (error) {
      this.error = error instanceof Error ? error.message : extractError(error, t("search_error"));
    } finally {
      this.busy = null;
    }
  }

  @action
  choose(book) {
    this.selected = book;
    this.readyFile = null;
    this.error = "";
    this.notice = "";
  }

  @action
  async download() {
    if (!this.selected || this.busy) {
      return;
    }
    const book = this.selected;
    this.busy = "download";
    this.error = "";
    this.notice = "";
    try {
      const file = await this.request("download", { selection: book.selection });
      const local = file.delivery === "forum" && /^\/uploads\/short-url\/[a-zA-Z0-9]+\.[a-zA-Z0-9]+$/.test(file.download_url);
      const url = new URL(local ? getURL(file.download_url) : file.download_url, window.location.origin);
      if ((!local && (file.delivery !== "provider" || url.protocol !== "https:")) || url.username || url.password) {
        throw new Error(t("download_error"));
      }
      this.readyFile = { url: url.href, filename: file.filename };
    } catch (error) {
      this.error = error instanceof Error ? error.message : extractError(error, t("download_error"));
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
                    >{{t "prepare"}}</button>
                    {{#if this.readyFile}}
                      <a class="btn btn-primary zlibrary-save" href={{this.readyFile.url}} download={{this.readyFile.filename}} rel="noreferrer" referrerpolicy="no-referrer">{{t "download"}}</a>
                    {{/if}}
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
