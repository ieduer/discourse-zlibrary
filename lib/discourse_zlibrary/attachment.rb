# frozen_string_literal: true

require "tempfile"
require_relative "error"

module DiscourseZlibrary
  class Attachment
    attr_reader :size

    def self.receive(response, max_bytes, deadline)
      expected = response["content-length"]
      if expected && !expected.match?(/\A[0-9]+\z/)
        raise Error.new(:incomplete)
      end
      raise Error.new(:too_large) if expected && expected.to_i > max_bytes
      raise Error.new(:verification) if response["content-type"].to_s.match?(%r{text/html|application/(?:xhtml\+xml|(?:[^;]+\+)?json)}i)
      encoding = response["content-encoding"].to_s.downcase
      raise Error.new(:upstream) unless ["", "identity"].include?(encoding)

      file = Tempfile.create("discourse-zlibrary", anonymous: true)
      begin
        file.binmode
        size = 0
        prefix = +"".b
        response.read_body do |chunk|
          raise Error.new(:timeout) if Transport.now >= deadline
          size += chunk.bytesize
          raise Error.new(:too_large) if size > max_bytes
          prefix << chunk.byteslice(0, 512 - prefix.bytesize).b if prefix.bytesize < 512
          file.write(chunk)
        end
        if size.zero? || (expected && size != expected.to_i)
          raise Error.new(:incomplete)
        end
        if prefix.match?(/\A(?:\xEF\xBB\xBF)?\s*(?:<!doctype\s+html\b|<html\b)/in)
          raise Error.new(:verification)
        end
        file.rewind
        attachment = new(file, size)
        file = nil # The response body now owns the descriptor.
        attachment
      ensure
        file&.close
      end
    end

    def initialize(file, size)
      @file = file
      @size = size
    end

    def each
      return enum_for(:each) unless block_given?
      begin
        while (chunk = @file.read(64 * 1024))
          yield chunk
        end
      ensure
        close
      end
    end

    def close
      @file.close unless @file.closed?
    end
  end
end
