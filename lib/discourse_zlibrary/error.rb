# frozen_string_literal: true

module DiscourseZlibrary
  class Error < StandardError
    STATUSES = {
      configuration: 503,
      account: 503,
      verification: 503,
      upstream: 502,
      timeout: 504,
      unavailable: 404,
      quota: 429,
      rate_limited: 429,
      too_large: 413,
      incomplete: 502,
      selection: 422,
      query: 422,
    }.freeze

    attr_reader :code

    def initialize(code)
      @code = code
      super(code.to_s)
    end

    def status
      STATUSES.fetch(code)
    end
  end
end
