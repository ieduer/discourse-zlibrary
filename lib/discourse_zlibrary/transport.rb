# frozen_string_literal: true

require "net/http"
require "openssl"
require "uri"
require_relative "error"

module DiscourseZlibrary
  class Transport
    def self.now
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def self.https_uri(value, base: nil)
      raise Error.new(:upstream) unless value.is_a?(String) && !value.empty? && value.bytesize <= 8192
      uri = base ? URI.join(base.to_s, value) : URI.parse(value)
      unless uri.is_a?(URI::HTTPS) && uri.host && !uri.host.empty? &&
               !uri.userinfo && uri.port == 443 && !uri.fragment
        raise Error.new(:upstream)
      end
      uri
    rescue URI::Error, ArgumentError
      raise Error.new(:upstream)
    end

    def request(uri, request, deadline:)
      remaining = deadline - Transport.now
      raise Error.new(:timeout) if remaining <= 0

      # FinalDestination pins the address after checking Discourse's network restrictions.
      connection = ::FinalDestination::HTTP.new(uri.hostname, uri.port, nil)
      connection.use_ssl = true
      connection.verify_mode = OpenSSL::SSL::VERIFY_PEER
      connection.open_timeout = [5, remaining].min
      connection.read_timeout = [12, remaining].min
      connection.write_timeout = [5, remaining].min
      connection.total_timeout = remaining
      connection.max_retries = 0
      connection.ignore_eof = false if connection.respond_to?(:ignore_eof=)
      # Return the handler's value. On a redirect, close without buffering its body.
      connection.start { |http| http.request(request) { |response| return yield(response) } }
    rescue Timeout::Error
      raise Error.new(:timeout)
    rescue SocketError, SystemCallError, IOError, OpenSSL::SSL::SSLError, Net::ProtocolError, Net::HTTPBadResponse
      raise Error.new(:upstream)
    end
  end
end
