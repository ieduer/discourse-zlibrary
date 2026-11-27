# frozen_string_literal: true

require "rails_helper"
require_relative "../../test/support/scripted_transport"

RSpec.describe "Searching and downloading books", type: :system do
  fab!(:member) { Fabricate(:user) }

  it "opens the forum library and downloads the chosen edition" do
    SiteSetting.zlibrary_enabled = true
    transport = ZLibraryTest::ScriptedTransport.new
    client = DiscourseZlibrary::Client.new(
      origin: "https://books.example", email: "reader@example.invalid", password: "fixture", http: transport
    )
    allow(DiscourseZlibrary).to receive(:client).and_return(client)
    transport.login
    transport.editions
    sign_in(member)
    visit("/z-library")
    within("form.zlibrary__search") do
      fill_in(I18n.t("js.zlibrary.query"), with: "試讀本")
      click_button(I18n.t("js.zlibrary.search"))
    end
    expect(page).to have_css(".zlibrary__book", count: 2)
    find(".zlibrary__book", text: "1910").click
    expect(transport.requests.length).to eq(2)
    bytes = "%PDF-1.4\nFixture\n%%EOF\n".b
    transport.add({ success: 1, file: { downloadLink: "https://cdn.example/sample.pdf" } })
    transport.add(bytes, headers: { "content-length" => bytes.bytesize.to_s })
    page.driver.with_playwright_page do |pw_page|
      download = pw_page.expect_download { click_button(I18n.t("js.zlibrary.download")) }
      expect(download.suggested_filename).to eq("試讀本.pdf")
      expect(File.binread(download.path)).to eq(bytes)
    end
    expect(transport.requests.map { |uri, _| uri.path }).to include("/eapi/book/53/def/file")
  end
end
