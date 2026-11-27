# frozen_string_literal: true

require "rails_helper"
require "base64"
require "open3"

RSpec.describe "Forum Book Library theme component", type: :system do
  fab!(:member) { Fabricate(:user) }
  let(:component_root) { File.expand_path("../..", __dir__) }

  it "imports into the active theme, then lets a member choose and download one edition" do
    component = RemoteTheme.import_theme_from_directory(component_root)
    expect(component.component).to be(true)
    Theme.find(SiteSetting.default_theme_id).child_themes << component
    component.update_setting(:book_service_path, "/z-library-api")
    component.save!
    visit("/")
    expect(page).to have_css(".d-header")
    expect(page).to have_no_css(".zlibrary-open")
    sign_in(member)
    visit("/")
    find(".zlibrary-open").click
    file_paths = []
    forum_server = Capybara.current_session.server.base_url
    page.driver.with_playwright_page do |browser|
      browser.route("**/z-library-api/**", lambda do |route, request|
        data = { forumServer: forum_server,
                 forumHost: URI(request.url).authority, cookie: request.all_headers.fetch("cookie", ""), operation: URI(request.url).path.split("/").last,
                 body: JSON.parse(request.post_data) }
        output, errors, status = Open3.capture3("node", File.join(component_root, "test/browser-worker.mjs"), stdin_data: JSON.generate(data))
        raise errors unless status.success?
        result = JSON.parse(output)
        if result["status"] != 200
          message = JSON.parse(Base64.strict_decode64(result.fetch("body"))).fetch("error")
          warn "Fixture #{data[:operation]} returned #{result['status']} #{message}, membership #{result['membership']}"
        end
        file_paths << result["filePath"] if result["filePath"]
        route.fulfill(status: result.fetch("status"), headers: result.fetch("headers"), body: Base64.strict_decode64(result.fetch("body")))
      end)
      within("form.zlibrary__search") do
        find('input[name="query"]').set("試讀本")
        find('button[type="submit"]').click
      end
      expect(page).to have_css(".zlibrary__book", count: 2)
      find(".zlibrary__book", text: "1910").click
      expect(file_paths).to be_empty
      download = browser.expect_download { find(".zlibrary__download button").click }
      expect(download.suggested_filename).to eq("試讀本.pdf")
      expect(File.binread(download.path)).to eq("%PDF-1.4\nFixture\n%%EOF\n".b)
      expect(file_paths).to eq(["/eapi/book/53/def/file"])
    end
  end
end
