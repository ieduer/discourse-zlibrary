# frozen_string_literal: true

require "json"

module ZLibraryTest
  # Recorded responses at the HTTP boundary; all production parsing and file handling still run.
  class ScriptedTransport
    Response = Struct.new(:code, :headers, :chunks) do
      def [](name)
        headers[name.downcase]
      end

      def read_body(&block)
        chunks.each(&block)
      end
    end

    attr_reader :requests

    def initialize
      @requests = []
      @queue = []
      @lock = Mutex.new
    end

    def add(body, status: 200, headers: {})
      chunks = body.is_a?(Hash) ? [JSON.generate(body)] : Array(body)
      @queue << Response.new(status.to_s, headers, chunks)
    end

    def request(uri, request, deadline:)
      response = @lock.synchronize do
        @requests << [uri, request]
        @queue.shift || raise("Unexpected fixture request: #{request.method} #{uri.path}")
      end
      yield response
    end

    def login(key = "fixture-key")
      add({ success: 1, user: { id: 17, remix_userkey: key } })
    end

    def editions(page: 1)
      add({
        success: 1, pagination: { current: page, total_pages: 2 },
        books: [
          { id: 51, hash: "abc", title: "試讀本", author: "Test Author", extension: "epub", year: 1900,
            language: "Chinese", filesize: 12, filesizeString: "12 B" },
          { id: 53, hash: "def", title: "試讀本", author: "Test Author", extension: "pdf", year: 1910 },
        ],
      })
    end
  end
end
