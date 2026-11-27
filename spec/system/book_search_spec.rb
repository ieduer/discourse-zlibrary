# frozen_string_literal: true

require "rails_helper"

RSpec.describe "Forum Book Library with the forum's native automation", type: :system do
  fab!(:member) { Fabricate(:user, trust_level: 2, refresh_auto_groups: true) }
  fab!(:inbox) { Fabricate(:group, name: "zlibrary", messageable_level: Group::ALIAS_LEVELS[:everyone]) }
  let(:root) { File.expand_path("../..", __dir__) }

  it "imports the component, searches in a group PM and downloads exactly the chosen edition" do
    SiteSetting.discourse_ai_enabled = true
    SiteSetting.discourse_automation_enabled = true
    Jobs.run_immediately!
    theme = RemoteTheme.import_theme_from_directory(root)
    expect(theme.component).to be(true)
    Theme.find(SiteSetting.default_theme_id).child_themes << theme
    theme.update_setting(:book_inbox_group, inbox.name)
    theme.save!
    definition = JSON.parse(File.read(File.join(root, "native/forum-book-tool.json"))).fetch("ai_tool")
    tool = AiTool.create!(definition.merge("enabled" => true, "created_by_id" => Discourse.system_user.id))
    secret = Fabricate(:ai_secret, secret: JSON.generate(origin: "https://books.example", email: "fixture@example.invalid", password: "fixture-only"))
    tool.replace_secret_bindings!([{ alias: "book_account", ai_secret_id: secret.id }])
    auto = DiscourseAutomation::Automation.create!(name: "Book library", script: "ai_tool_action", trigger: "post_created_edited", enabled: false)
    auto.upsert_field!("tool", "choices", { value: tool.id }, target: "script")
    auto.upsert_field!("action_type", "choices", { value: "created" }, target: "trigger")
    auto.upsert_field!("restricted_archetype", "choices", { value: "private_message" }, target: "trigger")
    auto.upsert_field!("restricted_inbox_groups", "groups", { value: [inbox.id] }, target: "trigger")
    auto.update!(enabled: true)

    paths = []
    bytes = "%PDF-1.4\nForum fixture\n%%EOF\n".b
    allow(DiscourseAi::Agents::Tools::Tool).to receive(:send_http_request) do |url, **options, &callback|
      path = URI(url).path
      paths << path
      body =
        case path
        when "/eapi/user/login"
          { success: 1, user: { id: 8, remix_userkey: "private-fixture-session" } }
        when "/eapi/book/search"
          expect(options[:headers].fetch("remix-userkey")).to eq("private-fixture-session")
          { success: 1, books: [{ id: 51, hash: "abc", title: "試讀本", year: 1900, extension: "epub" },
                                { id: 53, hash: "def", title: "試讀本", year: 1910, extension: "pdf" }] }
        when "/eapi/book/53/def/file"
          { success: 1, file: { downloadLink: "https://files.example/selected.pdf" } }
        else
          raise "Unexpected book request: #{path}"
        end
      callback.call(Struct.new(:body, :code).new(JSON.generate(body), "200"))
    end

    visit("/")
    expect(page).to have_css(".d-header")
    expect(page).to have_no_css(".zlibrary-open")
    sign_in(member)
    visit("/")
    find(".zlibrary-open").click
    within("form.zlibrary__search") do
      find('input[name="query"]').set("試讀本")
      find('button[type="submit"]').click
    end
    expect(page).to have_css(".zlibrary__book", count: 2), -> { "Book UI: #{page.all('.zlibrary', wait: 0).map(&:text)}; book calls: #{paths}; PM posts: #{Post.where('raw LIKE ?','book-library-%').pluck(:post_number, :user_id).inspect}" }
    find(".zlibrary__book", text: "1910").click
    expect(paths.grep(%r{/file$})).to be_empty
    find(".zlibrary__download button").click
    link = find("a.zlibrary-save")
    expect(link[:href]).to eq("https://files.example/selected.pdf")
    page.driver.with_playwright_page do |browser|
      browser.context.route("https://files.example/selected.pdf", lambda do |route, _request|
        route.fulfill(status: 200, contentType: "application/pdf", headers: { "Content-Disposition" => 'attachment; filename="selected.pdf"' }, body: bytes)
      end)
      download = browser.expect_download { link.click }
      expect(File.binread(download.path)).to eq(bytes)
    end
    expect(paths.grep(%r{/file$})).to eq(["/eapi/book/53/def/file"])
    request_post = Post.find_by!("raw LIKE ?", "book-library-request-v1%")
    expect(request_post.topic).to be_private_message
    expect(request_post.topic.allowed_groups).to include(inbox)
    expect(request_post.topic.posts.pluck(:raw).join).not_to include("private-fixture-session", "fixture-only")
  end
end
