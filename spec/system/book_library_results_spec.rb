# frozen_string_literal: true

require "rails_helper"

RSpec.describe "Forum book search result list", type: :system do
  fab!(:member) { Fabricate(:user) }

  it "keeps catalog order, skips download controls on unavailable rows, and pages through an empty page" do
    root = File.expand_path("../..", __dir__)
    theme = RemoteTheme.import_theme_from_directory(root)
    Theme.find(SiteSetting.default_theme_id).child_themes << theme
    theme.update_setting(:book_inbox_group, "zlibrary")
    theme.save!
    sign_in(member)
    visit("/")
    find(".zlibrary-open").click

    # Exercise the real modal and its PM protocol. The server-side search has its own integration coverage.
    requests = []
    workspace = { id: 8765, topic_id: 765432, post_number: 1, user_id: member.id }
    creations = 0
    records = (0..10).map do |i|
      { title: "Record #{i}", publisher: "Publisher #{i}", selection: nil }
    end
    records[0][:title] = ""
    [1, 10].each { |i| records[i].merge!(title: "Repeated title", selection: "77.#{i}", extension: "pdf") }
    pages = { 1 => records, 2 => [], 3 => [{ title: "Last record", selection: "80.0" }] }
    page.driver.with_playwright_page do |browser|
      json = ->(route, value) { route.fulfill(status: 200, contentType: "application/json", body: JSON.generate(value)) }
      handle = lambda do |raw|
        packet = JSON.parse(raw.match(/<!-- book-library-workspace-v2 (.+) -->$/)[1])
        if packet["kind"] == "request"
          requests << packet
          result = if packet.fetch("op") == "download"
            { delivery: "provider", download_url: "https://books.example/selected.pdf", filename: "selected.pdf" }
          else
            index = packet.fetch("page")
            { query: packet.fetch("query"), books: pages.fetch(index), page: index, total_pages: 3, has_next: index < 3 }
          end
          response = { kind: "result", nonce: packet.fetch("nonce"), result: result }
          workspace[:raw] = "Workspace.\n\n<!-- book-library-workspace-v2 #{JSON.generate(response)} -->"
        else
          workspace[:raw] = raw
        end
      end
      browser.route("**/groups/zlibrary/members.json?**", ->(route, _) { json.call(route, { members: [], owners: [] }) })
      browser.route("**/t/765432.json", ->(route, _) { json.call(route, { archetype: "private_message", details: { allowed_users: [{ id: member.id }], allowed_groups: [{ name: "zlibrary" }] } }) })
      browser.route("**/t/765432/notifications", ->(route, _) { json.call(route, { success: true }) })
      browser.route("**/t/765432/archive-message", ->(route, _) { json.call(route, { success: true }) })
      browser.route("**/posts.json", lambda do |route, _|
        creations += 1
        handle.call(route.request.post_data_json.fetch("raw"))
        json.call(route, workspace)
      end)
      browser.route("**/posts/8765.json*", lambda do |route, _|
        if route.request.method == "PUT"
          payload = route.request.post_data_json
          handle.call(payload["post[raw]"] || payload.dig("post", "raw"))
        end
        json.call(route, workspace)
      end)

      within("form.zlibrary__search") do
        find('input[name="query"]').set("catalog terms")
        find('button[type="submit"]').click
      end
      expect(page).to have_css(".zlibrary__book", count: 11)
      expect(all(".zlibrary__book .zlibrary__metadata").map { |row| row.text[/Publisher \d+/] }).to eq((0..10).map { |i| "Publisher #{i}" })
      expect(page).to have_css(".zlibrary__book input[type=radio]", count: 2)
      expect(page).to have_no_css(".zlibrary__book--unavailable input, .zlibrary-prepare")
      find(".zlibrary__book", text: "Publisher 10").click
      expect(page).to have_css(".zlibrary-prepare", count: 1)
      expect(requests.map { |r| r.fetch("op") }).to eq(["search"])
      find(".zlibrary-prepare").click
      expect(page).to have_css("a.zlibrary-save")
      expect(requests.last.fetch("selection")).to eq("77.10")

      find(".zlibrary__pages button:last-of-type").click
      expect(page).to have_css(".zlibrary__results p")
      expect(page).to have_no_css(".zlibrary__book, .zlibrary-prepare")
      find(".zlibrary__pages button:last-of-type").click
      expect(page).to have_css(".zlibrary__book", text: "Last record")
      expect(page).to have_css(".zlibrary__pages button:last-of-type[disabled]")
      find(".zlibrary__pages button:first-of-type").click
      expect(page).to have_css(".zlibrary__results p")
      expect(creations).to eq(1)
      expect(requests.select { |r| r.fetch("op") == "search" }.map { |r| r.fetch("page") }).to eq([1, 2, 3, 2])
    end
  end
end
