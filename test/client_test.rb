# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/discourse_zlibrary/client"
require_relative "support/scripted_transport"

class ZLibraryClientTest < Minitest::Test
  Client = DiscourseZlibrary::Client
  Error = DiscourseZlibrary::Error
  RECORD = { "id" => "53", "hash" => "def", "title" => "試讀本", "extension" => "pdf" }.freeze

  def setup
    @http = ZLibraryTest::ScriptedTransport.new
    @client = Client.new(origin: "https://books.example", email: "reader@example.invalid",
                         password: "test only!", http: @http)
  end

  def search
    @client.search(query: "試讀本", page: 1)
  end

  def download(size = 512 * 1024)
    @client.download(RECORD, max_bytes: size)
  end

  def assert_code(code, &block)
    error = assert_raises(Error, &block)
    assert_equal code, error.code
    refute_includes error.message, "fixture-key"
  end

  def test_selects_the_requested_edition_and_delivers_exact_bytes
    @http.login
    @http.editions
    @http.add({ success: 1, file: { downloadLink: "/delivery/book" } })
    @http.add([], status: 302, headers: { "location" => "https://cdn.example/book?temporary=fixture" })
    bytes = "%PDF-1.4\n\xff\x00\nfixture\n".b
    @http.add([bytes.byteslice(0, 5), bytes.byteslice(5..)], headers: { "content-length" => bytes.bytesize.to_s })
    result = @client.search(query: "  試讀本  ", page: "1", format: "pdf")
    assert result[:has_next]
    assert_equal [1, 2], result.values_at(:page, :total_pages)
    assert_equal %w[epub pdf], result[:books].map { |row| row["extension"] }
    assert_equal 2, @http.requests.length
    selected = result[:books].last
    attachment = @client.download(selected, max_bytes: 4096)
    assert_equal bytes.bytesize, attachment.size
    assert_equal bytes, attachment.each.to_a.join
    attachment.close
    assert_equal "試讀本.pdf", Client.filename(selected)
    login, lookup, grant, origin_file, cdn = @http.requests
    assert_equal ["/eapi/user/login", "/eapi/book/search", "/eapi/book/53/def/file"],
                 [login, lookup, grant].map { |uri, _| uri.path }
    assert_equal %w[POST POST GET], [login, lookup, grant].map { |_, req| req.method }
    assert_equal({ "email" => "reader@example.invalid", "password" => "test only!" }, URI.decode_www_form(login.last.body).to_h)
    assert_equal({ "message" => "試讀本", "page" => "1", "limit" => "20", "extensions[]" => "pdf" },
                 URI.decode_www_form(lookup.last.body).to_h)
    assert_equal "android", lookup.last["source"]
    assert_equal "17", lookup.last["remix-userid"]
    assert_equal "fixture-key", grant.last["remix-userkey"]
    assert_includes origin_file.last["cookie"], "remix_userkey=fixture-key"
    assert_equal "cdn.example", cdn.first.host
    %w[cookie remix-userid remix-userkey authorization].each { |header| assert_nil cdn.last[header] }
  end

  def test_empty_results_and_absent_pagination
    @http.login
    @http.add({ success: 1, books: [] })
    result = @client.search(query: "9781234567890", page: 2)
    assert_equal({ books: [], page: 2, total_pages: nil, has_next: false }, result)
    refute_includes @http.requests.last.last.body, "extensions"
  end

  def test_invalid_query_page_and_format_require_no_network
    [[" ", 1, ""], ["q", "0", ""], ["q", 1, ["pdf"]], ["q" * 201, 1, ""]].each do |q, p, f|
      assert_code(:query) { @client.search(query: q, page: p, format: f) }
    end
    assert_empty @http.requests
  end

  def test_password_file_works_and_missing_file_or_invalid_origin_is_reported
    env = { "ZLIBRARY_ORIGIN" => "https://books.example", "ZLIBRARY_EMAIL" => "fixture@example.invalid" }
    Tempfile.create("zlibrary-fixture") do |file|
      file.write("file password\n")
      file.flush
      assert_instance_of Client, Client.from_env(env.merge("ZLIBRARY_PASSWORD_FILE" => file.path))
    end
    assert_code(:configuration) { Client.from_env(env.merge("ZLIBRARY_PASSWORD_FILE" => "/no-fixture-here/zlib")) }
    ["", "http://books.example", "https://books.example/api", "https://owner@books.example"].each do |origin|
      assert_code(:configuration) { Client.from_env(env.merge("ZLIBRARY_ORIGIN" => origin, "ZLIBRARY_PASSWORD" => "fixture")) }
    end
  end

  def test_bad_login_is_not_repeated_on_every_search
    @http.add({ success: 0, error: "Invalid credentials" }, status: 400)
    2.times { assert_code(:account) { search } }
    assert_equal 1, @http.requests.length
  end

  def test_explicitly_expired_session_is_refreshed_once_including_legacy_key
    @http.login("old")
    @http.add({ success: 0, error: "Please login" }, status: 400)
    @http.add({ success: 1, user: { id: "17", remix_user_key: "fresh" } })
    @http.editions
    assert_equal 2, search[:books].size
    assert_equal "fresh", @http.requests.last.last["remix-userkey"]
    assert_equal 4, @http.requests.length
  end

  def test_concurrent_searches_share_one_login
    @http.login
    5.times { @http.editions }
    results = 5.times.map { Thread.new { search } }.map(&:value)
    assert results.all? { |r| r[:books].size == 2 }
    assert_equal 1, @http.requests.count { |uri, _| uri.path.end_with?("/login") }
  end

  def test_quota_and_verification_do_not_repeat_a_file_grant
    @http.login
    @http.add({ success: 0, error: "Daily download limit reached" }, status: 429)
    assert_code(:quota) { download }
    @http.add("<html>verification</html>", status: 403)
    assert_code(:verification) { download }
    assert_equal 3, @http.requests.length
  end

  def test_a_credential_rejection_on_both_attempts_stops
    2.times do
      @http.login
      @http.add({ success: 0, error: "Invalid credentials" }, status: 400)
    end
    2.times { assert_code(:account) { search } }
    assert_equal 4, @http.requests.length
  end

  def test_invalid_selection_and_known_oversize_fail_before_grant
    assert_code(:selection) { @client.download(RECORD.merge("hash" => "/other"), max_bytes: 100) }
    assert_code(:too_large) { @client.download(RECORD.merge("bytes" => 101), max_bytes: 100) }
    assert_empty @http.requests
  end

  def test_all_file_link_shapes_and_binary_without_length
    @http.login
    %w[downloadLink url link].each do |key|
      @http.add({ "success" => 1, key => "https://cdn.example/file" })
      @http.add(["abc", "def"])
      assert_equal "abcdef", download.each.to_a.join
    end
  end

  def test_refuses_expired_html_partial_and_oversized_transfers
    @http.login
    [
      [:incomplete, [], {}],
      [:incomplete, "12", { "content-length" => "4" }],
      [:too_large, ["123", "45"], {}],
      [:too_large, "x", { "content-length" => "15" }],
      [:verification, "<x>", { "content-type" => "text/html" }],
      [:verification, ["<ht", "ml>"], {}],
    ].each do |code, chunks, headers|
      @http.add({ success: 1, url: "/file" })
      @http.add(chunks, headers: headers)
      assert_code(code) { download(code == :verification ? 64 : 4) }
    end
  end

  def test_redirects_allow_only_https_and_have_a_finite_bound
    @http.login
    @http.add({ success: 1, url: "/file" })
    @http.add([], status: 302, headers: { "location" => "http://cdn.example/book" })
    assert_code(:upstream) { download }
    @http.add({ success: 1, url: "/file" })
    5.times { @http.add([], status: 307, headers: { "location" => "/loop" }) }
    assert_code(:upstream) { download }
    assert_equal 9, @http.requests.length
  end

  def test_file_name_is_safe_for_a_download_header
    name = Client.filename("title" => "../\r\n小說/選讀.pdf", "extension" => "pdf")
    assert_match(/小說 選讀\.pdf\z/, name)
    refute_match(/[\r\n\/\\]/, name)
    assert_operator Client.filename(RECORD.merge("title" => "繁" * 400)).bytesize, :<, 256
  end
end
