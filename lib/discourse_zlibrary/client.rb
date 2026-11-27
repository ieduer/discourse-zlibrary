# frozen_string_literal: true

require "json"
require_relative "transport"
require_relative "attachment"

module DiscourseZlibrary
  class Client
    PAGE_SIZE = 20
    FORMATS = %w[epub pdf mobi azw3 djvu fb2 txt].freeze
    MAX_METADATA = 2 * 1024 * 1024
    SESSION_KEY = /\A[A-Za-z0-9._~%+=\/-]{1,512}\z/
    RECORD_PART = /\A[A-Za-z0-9_-]{1,128}\z/
    REDIRECTS = %w[301 302 303 307 308].freeze
    SessionRejected = Class.new(StandardError)

    def self.from_env(env = ENV)
      password_file = env["ZLIBRARY_PASSWORD_FILE"].to_s
      password = env["ZLIBRARY_PASSWORD"]
      unless password_file.empty?
        raise Error.new(:configuration) unless password_file.start_with?("/")
        password = File.binread(password_file, 4097).force_encoding("UTF-8").chomp
        raise Error.new(:configuration) unless password.valid_encoding? && password.bytesize <= 4095
      end
      new(origin: env["ZLIBRARY_ORIGIN"], email: env["ZLIBRARY_EMAIL"], password: password)
    rescue SystemCallError, IOError
      raise Error.new(:configuration)
    end

    def initialize(origin:, email:, password:, http: Transport.new)
      begin
        @origin = Transport.https_uri(origin.to_s.strip)
      rescue Error
        raise Error.new(:configuration)
      end
      unless ["", "/"].include?(@origin.path) && !@origin.query
        raise Error.new(:configuration)
      end
      @email = email.to_s.strip
      @password = password.to_s
      raise Error.new(:configuration) if @email.empty? || @password.empty?
      @http = http
      @session_lock = Mutex.new
      @failed_until = 0
    end

    def search(query:, page:, format: "")
      unless query.is_a?(String) && (1..200).cover?(query.strip.size) &&
               (page.is_a?(Integer) || page.is_a?(String)) && page.to_s.match?(/\A[1-9]\d{0,5}\z/) &&
               (format == "" || FORMATS.include?(format))
        raise Error.new(:query)
      end

      form = { "message" => query.strip, "page" => page.to_s, "limit" => PAGE_SIZE.to_s }
      form["extensions[]"] = format unless format.empty?
      payload = with_session { |session| api("/eapi/book/search", session:, form:) }
      rows = payload["books"]
      raise Error.new(:upstream) unless rows.is_a?(Array)
      pagination = payload["pagination"]
      pagination = {} unless pagination.is_a?(Hash)
      current = positive_number(pagination["current"]) || page.to_i
      total = positive_number(pagination["total_pages"])
      {
        books: rows.first(PAGE_SIZE).filter_map { |row| book_record(row) },
        page: current,
        total_pages: total,
        has_next: total ? current < total : rows.length >= PAGE_SIZE,
      }
    end

    def download(record, max_bytes:)
      unless record.is_a?(Hash) && [record["id"], record["hash"]].all? { |part| part.is_a?(String) && RECORD_PART.match?(part) }
        raise Error.new(:selection)
      end
      if record["bytes"].is_a?(Integer) && record["bytes"] > max_bytes
        raise Error.new(:too_large)
      end
      path = "/eapi/book/#{record.fetch("id")}/#{record.fetch("hash")}/file"
      payload, session = with_session { |auth| [api(path, session: auth), auth] }
      nested = payload["file"]
      link = [nested.is_a?(Hash) && nested["downloadLink"], payload["downloadLink"], payload["url"], payload["link"]]
        .find { |candidate| candidate.is_a?(String) && !candidate.empty? }
      raise Error.new(:unavailable) unless link
      fetch_attachment(Transport.https_uri(link, base: @origin), session, max_bytes)
    end

    def self.filename(record)
      ext = record["extension"].to_s
      ext = "bin" unless ext.match?(/\A[a-z0-9]{1,12}\z/)
      name = record["title"].to_s.gsub(/[[:cntrl:]\p{Cf}\\\/:*?"<>|]/, " ").strip
      name = name.sub(/\A\.+/, "").sub(/\.#{Regexp.escape(ext)}\z/i, "").strip
      # Stay within a filesystem component's byte limit with multibyte book titles.
      name = name.byteslice(0, 220).to_s.scrub("").sub(/[. ]+\z/, "")
      "#{name.empty? ? "book" : name}.#{ext}"
    end

    private

    def positive_number(value)
      return unless (value.is_a?(Integer) || value.is_a?(String)) && value.to_s.match?(/\A\d{1,16}\z/)
      number = value.to_i
      number if number.positive?
    end

    def metadata(value, limit = 300)
      return "" unless value.is_a?(String) || value.is_a?(Numeric)
      value.to_s.gsub(/[[:cntrl:]\p{Cf}]+/, " ").strip[0, limit]
    end

    def book_record(row)
      return unless row.is_a?(Hash)
      id = row["id"].to_s
      hash = row["hash"]
      return unless RECORD_PART.match?(id) && hash.is_a?(String) && RECORD_PART.match?(hash)
      title = metadata(row["title"])
      return if title.empty?
      ext = metadata(row["extension"], 12).downcase
      size = metadata(row["filesizeString"], 48)
      bytes = positive_number(row["filesize"])
      size = "#{bytes} B" if size.empty? && bytes
      {
        "id" => id, "hash" => hash, "title" => title, "author" => metadata(row["author"]),
        "publisher" => metadata(row["publisher"]), "year" => metadata(row["year"], 12),
        "language" => metadata(row["language"], 64), "size" => size, "bytes" => bytes,
        "extension" => ext.match?(/\A[a-z0-9]+\z/) ? ext : "",
      }
    end

    def api(path, session: nil, form: nil)
      uri = URI.join(@origin.to_s, path)
      req = form ? Net::HTTP::Post.new(uri) : Net::HTTP::Get.new(uri)
      req.set_form_data(form) if form
      req["Accept"] = "application/json"
      req["Accept-Encoding"] = "identity"
      req["User-Agent"] = "Discourse-ZLibrary/1.0"
      req["source"] = "android"
      if session
        req["remix-userid"], req["remix-userkey"] = session
        req["Cookie"] = cookie(session)
      end
      deadline = Transport.now + 10
      @http.request(uri, req, deadline:) do |response|
        data = +"".b
        response.read_body do |chunk|
          raise Error.new(:timeout) if Transport.now >= deadline
          raise Error.new(:upstream) if data.bytesize + chunk.bytesize > MAX_METADATA
          data << chunk.b
        end
        parse_api(data, response.code.to_i, session)
      end
    end

    def parse_api(body, status, session)
      json = begin
        JSON.parse(body.delete_prefix("\xEF\xBB\xBF".b))
      rescue JSON::ParserError
        nil
      end
      valid = json.is_a?(Hash)
      return json if (200..299).cover?(status) && valid && json["success"].to_s == "1"

      message = valid ? json["error"].to_s.downcase.strip : ""
      if message.match?(/quota|daily.{0,35}limit|download.{0,35}limit|limit.{0,35}download/)
        raise Error.new(:quota)
      end
      raise Error.new(:rate_limited) if status == 429
      if session && (status == 401 || ["invalid credentials", "please login", "please log in", "not logged in"].include?(message))
        raise SessionRejected
      end
      if status == 403 || message.match?(/captcha|challenge|verification/) || (!valid && body.lstrip.start_with?("<") && status == 200)
        raise Error.new(:verification)
      end
      raise Error.new(:unavailable) if status == 404 || message.match?(/book not found|file not found/)
      raise Error.new(:account) if !session && (status == 401 || (valid && json["success"].to_s == "0"))
      raise Error.new(:upstream)
    end

    def with_session
      first = session_for
      begin
        yield first
      rescue SessionRejected
        renewed = session_for(first)
        begin
          yield renewed
        rescue SessionRejected
          @session_lock.synchronize do
            if @session.equal?(renewed)
              @session = nil
              remember_login_failure(:account)
            end
          end
          raise Error.new(:account)
        end
      end
    end

    def session_for(rejected = nil)
      @session_lock.synchronize do
        return @session if @session && !@session.equal?(rejected)
        raise Error.new(@failed_code) if Transport.now < @failed_until
        @session = nil
        begin
          user = api("/eapi/user/login", form: { "email" => @email, "password" => @password })["user"]
          raise Error.new(:account) unless user.is_a?(Hash)
          uid = user["id"].to_s
          key = user["remix_userkey"]
          key = user["remix_user_key"] if !key.is_a?(String) || key.empty?
          unless uid.match?(/\A\d{1,32}\z/) && key.is_a?(String) && SESSION_KEY.match?(key)
            raise Error.new(:account)
          end
          @session = [uid, key].freeze
        rescue Error => e
          remember_login_failure(e.code)
          raise
        end
      end
    end

    def remember_login_failure(code)
      @failed_code = code
      @failed_until = Transport.now + 30
    end

    def cookie(session)
      "remix_userid=#{session.first}; remix_userkey=#{session.last}"
    end

    def fetch_attachment(uri, session, max_bytes)
      deadline = Transport.now + 50
      5.times do
        req = Net::HTTP::Get.new(uri)
        req["Accept-Encoding"] = "identity"
        req["User-Agent"] = "Discourse-ZLibrary/1.0"
        req["Cookie"] = cookie(session) if uri.host.casecmp?(@origin.host)
        result = @http.request(uri, req, deadline:) do |response|
          case response.code
          when "200" then Attachment.receive(response, max_bytes, deadline)
          when *REDIRECTS then Transport.https_uri(response["location"], base: uri)
          when "401", "403" then raise Error.new(:verification)
          when "404", "410" then raise Error.new(:unavailable)
          when "429" then raise Error.new(:rate_limited)
          else raise Error.new(:upstream)
          end
        end
        return result if result.is_a?(Attachment)
        uri = result
      end
      raise Error.new(:upstream)
    end
  end
end
