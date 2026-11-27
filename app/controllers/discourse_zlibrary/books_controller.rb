# frozen_string_literal: true

module DiscourseZlibrary
  class BooksController < ::ApplicationController
    requires_login
    requires_plugin PLUGIN_NAME
    before_action :private_response
    rescue_from Error, with: :book_error

    def index
      render json: { formats: Client::FORMATS, max_mb: SiteSetting.zlibrary_max_download_mb }
    end

    def search
      RateLimiter.new(current_user, "zlibrary-search", 30, 60).performed!
      result = DiscourseZlibrary.client.search(
        query: params[:query], page: params.fetch(:page, 1), format: params.fetch(:extension, "")
      )
      books = result[:books].map do |record|
        key = verifier.generate(
          record.slice("id", "hash", "title", "extension", "bytes"),
          purpose: selection_purpose,
          expires_in: 20.minutes,
        )
        record.except("id", "hash").merge("selection" => key)
      end
      render json: result.merge(books: books)
    end

    def download
      key = params[:selection]
      raise Error.new(:selection) unless key.is_a?(String) && (1..4096).cover?(key.bytesize)
      record = verifier.verified(key, purpose: selection_purpose)
      raise Error.new(:selection) unless record.is_a?(Hash)
      RateLimiter.new(current_user, "zlibrary-download", 6, 60).performed!
      attachment = DiscourseZlibrary.client.download(record, max_bytes: download_limit.megabytes)
      send_file_headers!(filename: Client.filename(record), type: "application/octet-stream", disposition: "attachment")
      response.headers["Content-Length"] = attachment.size.to_s
      response.headers["Last-Modified"] = Time.now.httpdate
      response.headers["X-Content-Type-Options"] = "nosniff"
      self.response_body = attachment
      attachment = nil # Rack owns the body through delivery or disconnect.
    ensure
      attachment&.close
    end

    private

    def verifier
      Rails.application.message_verifier("discourse-zlibrary-selection")
    end

    def selection_purpose
      "zlibrary:#{RailsMultisite::ConnectionManagement.current_db}:#{current_user.id}"
    end

    def private_response
      response.headers["Cache-Control"] = "private, no-store"
    end

    def download_limit
      forum_limit = SiteSetting.zlibrary_max_download_mb
      params[:hub] == true ? [forum_limit, 25].min : forum_limit
    end

    def book_error(error)
      limit = download_limit
      render json: { errors: [I18n.t("zlibrary.errors.#{error.code}", limit: limit)] }, status: error.status
    end
  end
end
