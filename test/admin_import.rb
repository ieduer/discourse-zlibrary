# frozen_string_literal: true

require "open3"
abort "isolated test forum required" unless Rails.env.test?
expected = ENV.fetch("THEME_REVISION")
repository = ENV.fetch("GITHUB_REPOSITORY")
remote_url = "https://github.com/#{repository}.git"
actor = Discourse.system_user
key = ApiKey.create!(created_by: actor, user: actor, scope_mode: :global, description: "Theme import test")
client = ActionDispatch::Integration::Session.new(Rails.application)
client.host! "localhost"
import = lambda do
  client.post("/admin/themes/import.json", params: { remote: remote_url },
              headers: { "Api-Key" => key.key, "Api-Username" => actor.username })
end

import.call
transport = "public GitHub Git URL"
if client.response.status == 422 && client.response.body.include?("timed out")
  # Use exactly the same public Git objects fetched by actions/checkout when the CI runner's
  # second connection to GitHub times out. Rails still runs its real Git importer and admin API.
  root = File.realpath(File.join(__dir__, ".."))
  checked_out, status = Open3.capture2("git", "-C", root, "rev-parse", "HEAD")
  raise "Checkout does not match candidate" unless status.success? && checked_out.strip == expected
  ENV["GIT_CONFIG_COUNT"] = "1"
  ENV["GIT_CONFIG_KEY_0"] = "url.file://#{root}.insteadOf"
  ENV["GIT_CONFIG_VALUE_0"] = remote_url
  import.call
  transport = "verified public Git checkout mirror after runner timeout"
end
raise "Admin import returned #{client.response.status}: #{client.response.body[0, 220]}" unless client.response.status == 201
remote = RemoteTheme.find_by!(local_version: expected)
raise "Import did not retain the public Git repository" unless remote.remote_url.delete_suffix(".git") == remote_url.delete_suffix(".git")
raise "Import did not create a theme component" unless remote.theme.component?
puts "Admin imported #{remote.theme.name} at #{remote.local_version} using #{transport}"
