# frozen_string_literal: true

# name: discourse-zlibrary
# about: Search a shared Z-Library account and download a selected edition inside Discourse.
# version: 1.0.0
# authors: suen
# url: https://github.com/ieduer/discourse-zlibrary
# required_version: 2026.10.2

enabled_site_setting :zlibrary_enabled
register_asset "stylesheets/z-library.scss"
register_svg_icon "book-open"

module ::DiscourseZlibrary
  PLUGIN_NAME = "discourse-zlibrary"
  CLIENT_LOCK = Mutex.new

  def self.client
    CLIENT_LOCK.synchronize { @client ||= Client.from_env }
  end
end

require_relative "lib/discourse_zlibrary/engine"
require_relative "lib/discourse_zlibrary/client"
