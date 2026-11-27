# frozen_string_literal: true

require "rails_helper"
require_relative "../../test/support/scripted_transport"

RSpec.describe "Discourse Z-Library", type: :request do
  fab!(:member) { Fabricate(:user) }
  fab!(:other_member) { Fabricate(:user) }
  let(:transport) { ZLibraryTest::ScriptedTransport.new }
  let(:client) do
    DiscourseZlibrary::Client.new(
      origin: "https://books.example", email: "reader@example.invalid", password: "only a fixture", http: transport
    )
  end

  before do
    SiteSetting.zlibrary_enabled = true
    allow(DiscourseZlibrary).to receive(:client).and_return(client)
  end

  def select_pdf
    transport.login
    transport.editions
    post "/z-library/search.json", params: { query: "試讀本" }
    expect(response).to have_http_status(:ok)
    expect(response.headers["Cache-Control"]).to include("no-store")
    expect(response.body).not_to include("remix_user", "fixture-key", "reader@example.invalid", "downloadLink")
    rows = response.parsed_body.fetch("books")
    expect(rows.pluck("extension")).to eq(%w[epub pdf])
    rows.last.fetch("selection")
  end

  it "serves the forum page and downloads exactly the selected edition" do
    sign_in(member)
    get "/z-library"
    expect(response).to have_http_status(:ok)
    get "/z-library.json"
    expect(response.parsed_body.fetch("formats")).to include("pdf")
    selection = select_pdf
    transport.add({ success: 1, file: { downloadLink: "https://cdn.example/book" } })
    bytes = "%PDF-1.4\x00\xff".b
    transport.add(bytes, headers: { "content-length" => bytes.bytesize.to_s })
    post "/z-library/download", params: { selection: selection, hub: false }, as: :json,
         headers: { "X-Requested-With" => "XMLHttpRequest" }
    expect(response).to have_http_status(:ok)
    expect(response.body.b).to eq(bytes)
    expect(response.media_type).to eq("application/octet-stream")
    expect(response.headers.fetch("Content-Disposition")).to include("attachment", ".pdf")
    expect(transport.requests.map { |uri, _| uri.path }).to include("/eapi/book/53/def/file")
  end

  it "requires forum membership for both operations" do
    post "/z-library/search.json", params: { query: "book" }
    expect(response.status).to be_in([401, 403])
    post "/z-library/download.json", params: { selection: "invalid" }
    expect(response.status).to be_in([401, 403])
    expect(transport.requests).to be_empty
  end

  it "rejects another member's selection, tampering, and an expired selection before resolving any file" do
    sign_in(member)
    selection = select_pdf
    sign_in(other_member)
    post "/z-library/download.json", params: { selection: selection }
    expect(response).to have_http_status(422)
    sign_in(member)
    post "/z-library/download.json", params: { selection: "#{selection}x" }
    expect(response).to have_http_status(422)
    freeze_time 21.minutes.from_now
    post "/z-library/download.json", params: { selection: selection }
    expect(response).to have_http_status(422)
    expect(transport.requests.size).to eq(2)
  end

  it "surfaces an account quota error without a file or credential in the response" do
    sign_in(member)
    selection = select_pdf
    transport.add({ success: 0, error: "Daily download limit reached" }, status: 429)
    post "/z-library/download.json", params: { selection: selection }
    expect(response).to have_http_status(429)
    expect(response.parsed_body.fetch("errors")).to eq([I18n.t("zlibrary.errors.quota")])
    expect(response.headers["Content-Disposition"]).to be_nil
  end

  it "honours the plugin setting for both APIs" do
    sign_in(member)
    SiteSetting.zlibrary_enabled = false
    post "/z-library/search.json", params: { query: "book" }
    expect(response).to have_http_status(:not_found)
    post "/z-library/download.json", params: { selection: "unused" }
    expect(response).to have_http_status(:not_found)
    expect(transport.requests).to be_empty
  end
end
