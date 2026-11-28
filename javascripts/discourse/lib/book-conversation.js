import { ajax } from "discourse/lib/ajax";
import User from "discourse/models/user";
import { i18n } from "discourse-i18n";

export const t = (key, options) => i18n(themePrefix(`zlibrary.${key}`), options);
const knownErrors = new Set(["configuration", "account", "verification", "upstream", "unavailable", "quota", "rate_limited", "incomplete", "selection", "query", "attachment", "pending"]);
const marker = "book-library-workspace-v2";
const queues = new Map();

function pack(packet) {
  return JSON.stringify(packet).replace(/[<>&-]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

function unpack(raw) {
  const match = typeof raw === "string" && raw.match(/\n\n<!-- book-library-workspace-v2 (.+) -->$/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

export default class BookConversation {
  constructor(group) {
    this.group = group;
  }

  request(op, fields, active) {
    const user = User.current();
    if (!user) return Promise.reject(new Error(t("errors.membership")));
    const key = [marker, user.id, this.group].join(":");
    const run = () => this.exchange(key, user.id, op, fields, active);
    if (navigator.locks) return navigator.locks.request(key, run);
    const prior = queues.get(key) || Promise.resolve();
    const current = prior.then(run, run);
    queues.set(key, current);
    return current.finally(() => { if (queues.get(key) === current) queues.delete(key); });
  }

  async exchange(key, userId, op, fields, active) {
    if (!active()) throw new Error(t("errors.pending"));
    const storage = navigator.locks ? window.localStorage : window.sessionStorage;
    const members = await ajax(`/groups/${encodeURIComponent(this.group)}/members.json`, { data: { limit: 1 } });
    if (!Array.isArray(members.members) || members.members.length || members.owners?.length) {
      throw new Error(t("errors.configuration"));
    }
    const nonce = crypto.randomUUID();
    const raw = t("workspace_note") + "\n\n<!-- " + marker + " " + pack({ kind: "request", nonce, op, ...fields }) + " -->";
    let savedTopicId;
    let postId = Number(storage.getItem(key));
    if (Number.isSafeInteger(postId) && postId > 0) {
      let saved;
      try { saved = await ajax(`/posts/${postId}.json`, { data: { include_raw: true } }); }
      catch (error) { if (![403, 404].includes(error.jqXHR?.status || error.status)) throw error; }
      savedTopicId = saved?.topic_id;
      // Only an original, app-created document belonging to this reader may be overwritten.
      if (!saved || saved.user_id !== userId || saved.post_number !== 1 || !unpack(saved.raw) || saved.can_edit === false) postId = 0;
    }
    if (postId > 0) {
      const prior = await ajax(`/t/${savedTopicId}.json`);
      const groups = prior.details?.allowed_groups || [];
      const people = prior.details?.allowed_users || [];
      if (prior.archetype !== "private_message" || groups.length !== 1 || groups[0].name !== this.group ||
          people.some(person => person.id !== userId)) postId = 0;
    }
    if (postId > 0) {
      await ajax(`/posts/${postId}.json`, { type: "PUT", data: { post: { raw } } });
    } else {
      const response = await ajax("/posts.json", { type: "POST", data: {
        raw, archetype: "private_message", target_recipients: this.group, title: t("workspace_title"),
      } });
      const sent = response.post || response;
      if (!sent.id || !sent.topic_id || sent.post_number !== 1) throw new Error(t("errors.pending"));
      postId = sent.id;
      savedTopicId = sent.topic_id;
      storage.setItem(key, String(postId));
    }
    if (storage.getItem(key + ":archived") !== String(postId)) {
      await ajax(`/t/${savedTopicId}/notifications`, { type: "POST", data: { notification_level: 0 } });
      await ajax(`/t/${savedTopicId}/archive-message`, { type: "PUT" });
      storage.setItem(key + ":archived", String(postId));
    }
    const deadline = Date.now() + 90000;
    let delay = 450;
    while (Date.now() < deadline && active()) {
      const saved = await ajax(`/posts/${postId}.json`, { data: { include_raw: true } });
      const packet = unpack(saved.raw);
      if (saved.user_id === userId && packet?.kind === "result" && packet.nonce === nonce) {
        const upload = packet.result?.short_url;
        const fileLink = typeof upload === "string" && /^upload:\/\/[a-zA-Z0-9]+\.[a-zA-Z0-9]+$/.test(upload) ? "\n\n[Download](" + upload + ")" : "";
        const idle = t("workspace_note") + fileLink + "\n\n<!-- " + marker + ' {"kind":"idle"} -->';
        await ajax(`/posts/${postId}.json`, { type: "PUT", data: { post: { raw: idle } } });
        const error = packet.result?.error;
        if (error) throw new Error(t("errors." + (knownErrors.has(error) ? error : "upstream")));
        return packet.result;
      }
      await new Promise(resolve => window.setTimeout(resolve, delay));
      delay = Math.min(delay + 400, 2500);
    }
    throw new Error(t("errors.pending"));
  }
}
