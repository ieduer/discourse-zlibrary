# frozen_string_literal: true

require "rails_helper"
require "zip"

RSpec.describe "Forum Book Library with the forum's native automation", type: :system do
  fab!(:member) { Fabricate(:user, trust_level: 2, refresh_auto_groups: true) }
  fab!(:inbox) { Fabricate(:group, name: "zlibrary", messageable_level: Group::ALIAS_LEVELS[:everyone]) }
  let(:root) { File.expand_path("../..", __dir__) }
  let(:epub) do
    Zip::OutputStream.write_buffer do |zip|
      zip.put_next_entry("mimetype", nil, nil, Zip::Entry::STORED)
      zip.write("application/epub+zip")
      zip.put_next_entry("META-INF/container.xml")
      zip.write('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
      zip.put_next_entry("book.opf")
      zip.write('<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Sample</dc:title><dc:language>en</dc:language><dc:identifier id="id">sample</dc:identifier></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>')
      zip.put_next_entry("chapter.xhtml")
      zip.write('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Sample</title></head><body><p>Forum reader test.</p></body></html>')
    end.string
  end

  def process_book_request(automation)
    worker = Jobs::DiscourseAutomation::Trigger
    try_until_success do
      automation_ids = worker.jobs.map { |job| job.fetch("args").first.fetch("automation_id") }
      expect(automation_ids).to include(automation.id)
    end
    # Sidekiq executes this after the post-created event has returned.
    worker.drain
    expect(automation.stats.sum(:total_errors)).to eq(0)
  end

  it "imports the component, searches in a group PM and downloads exactly the chosen edition" do
    SiteSetting.discourse_ai_enabled = true
    SiteSetting.discourse_automation_enabled = true
    SiteSetting.authorized_extensions = (SiteSetting.authorized_extensions.split("|") | ["epub"]).join("|")
    Jobs.run_later!
    theme = RemoteTheme.import_theme_from_directory(root)
    expect(theme.component).to be(true)
    Theme.find(SiteSetting.default_theme_id).child_themes << theme
    theme.update_setting(:book_inbox_group, inbox.name)
    theme.save!
    definition = JSON.parse(File.read(File.join(root, "native/forum-book-tool.json"))).fetch("ai_tool")
    tool = AiTool.create!(definition.merge("enabled" => true, "created_by_id" => Discourse.system_user.id))
    secret = Fabricate(:ai_secret, secret: JSON.generate(origin: "https://books.example", email: "fixture@example.invalid", password: "fixture-only"))
    tool.replace_secret_bindings!([{ alias: "book_account", ai_secret_id: secret.id }])
    auto = DiscourseAutomation::Automation.create!(name: "Book library", script: "ai_tool_action", trigger: "post_created_edited", last_updated_by_id: Discourse.system_user.id, enabled: false)
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
          { success: 1, books: [{ id: 53, hash: "def", title: "試讀本", year: 1910, extension: "pdf" },
                                { id: 51, hash: "abc", title: "試讀本", year: 1900, extension: "epub", filesize: epub.bytesize }] }
        when "/eapi/book/53/def/file"
          { success: 1, file: { downloadLink: "https://files.example/selected.pdf" } }
        when "/eapi/book/51/abc/file"
          { success: 1, file: { downloadLink: "https://files.example/selected.epub" } }
        when "/selected.epub"
          expect(options.fetch(:headers)).not_to have_key("Cookie")
          callback.call(Struct.new(:body, :code).new(epub, "200"))
          next
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
    process_book_request(auto)
    expect(paths).to eq(["/eapi/user/login", "/eapi/book/search"])
    expect(page).to have_css(".zlibrary__book", count: 2)
    find(".zlibrary__book", text: "1910").click
    expect(paths.grep(%r{/file$})).to be_empty
    find(".zlibrary-prepare").click
    process_book_request(auto)
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

    bot = Fabricate(:user, username: "ZlibBot", trust_level: 2, refresh_auto_groups: true)
    topic = Fabricate(:topic, user: member, category: Fabricate(:category))
    Fabricate(:post, topic: topic, user: member, raw: "Book discussion for the forum test.")
    public_auto = DiscourseAutomation::Automation.create!(name: "Book mentions", script: "ai_tool_action", trigger: "post_created_edited", last_updated_by_id: Discourse.system_user.id)
    public_auto.upsert_field!("tool", "choices", { value: tool.id }, target: "script")
    public_auto.upsert_field!("action_type", "choices", { value: "created" }, target: "trigger")
    public_auto.upsert_field!("restricted_archetype", "choices", { value: "public" }, target: "trigger")
    public_auto.upsert_field!("post_features", "choices", { value: ["with_links"] }, target: "trigger")
    public_auto.update!(enabled: true)
    PostCreator.create!(member, topic_id: topic.id, raw: "@ZlibBot 試讀本", skip_validations: true)
    process_book_request(public_auto)
    answer = topic.posts.find_by!(user_id: bot.id)
    expect(answer.raw).to match(/1900.*EPUB.*1910.*PDF/m)
    expect(paths).not_to include("/eapi/book/51/abc/file")
    visit(topic.relative_url)
    find("a[href*='#zlibrary-edition-'][href$='-epub']").click
    expect(page).to have_css(".zlibrary-embed")
    expect(paths).not_to include("/eapi/book/51/abc/file")
    find(".zlibrary-embed").click
    process_book_request(auto)
    find("#reply-control button.create").click
    expect(page).to have_css(".topic-post .cooked a.attachment", text: /試讀本\.epub/)
    expect(Upload.find_by!(sha1: Digest::SHA1.hexdigest(epub)).extension).to eq("epub")
  end
end
