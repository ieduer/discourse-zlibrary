import { ajax } from "discourse/lib/ajax";
import { i18n } from "discourse-i18n";

export const t = (key, options) => i18n(themePrefix(`zlibrary.${key}`), options);
const knownErrors = new Set(["configuration", "account", "verification", "upstream", "unavailable", "quota", "rate_limited", "incomplete", "selection", "query", "attachment", "pending"]);

function replyPayload(post) {
  if (post.user_id !== -1) return null;
  const doc = new DOMParser().parseFromString(post.cooked || "", "text/html");
  const code = doc.querySelector("pre code");
  if (!code) return null;
  try { return JSON.parse(code.textContent); } catch { return null; }
}

export default class BookConversation {
  constructor(group) {
    this.group = group;
    this.topicId = null;
  }

  async request(operation, fields, active) {
    const nonce = crypto.randomUUID();
    const raw = "book-library-request-v1\n" + JSON.stringify({ op: operation, nonce, ...fields });
    const target = this.topicId
      ? { topic_id: this.topicId }
      : { archetype: "private_message", target_recipients: this.group,
          title: t("pm_title") + " " + nonce.slice(0, 13) };
    const created = await ajax("/posts.json", { type: "POST", data: { ...target, raw } });
    const sent = created.post || created;
    if (!sent.topic_id || !sent.post_number) throw new Error(t("errors.pending"));
    this.topicId = sent.topic_id;
    const deadline = Date.now() + 90000;
    let delay = 600;
    while (Date.now() < deadline && active()) {
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
}
