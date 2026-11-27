# frozen_string_literal: true

# This runs in the isolated test forum after a push. The admin key exists in that database only.
abort "test environment required" unless Rails.env.test?
actor = Discourse.system_user
key = ApiKey.create!(created_by: actor, user: actor, scope_mode: :global, description: "Theme import test")
begin
  client = ActionDispatch::Integration::Session.new(Rails.application)
  client.host! "localhost"
  client.post("/admin/themes/import.json",
              params: { remote: "https://github.com/ieduer/discourse-zlibrary" },
              headers: { "Api-Key" => key.key, "Api-Username" => actor.username })
  abort "Admin theme import returned #{client.response.status}: #{client.response.body[0, 500]}" unless client.response.status == 201
  remote = RemoteTheme.find_by!(local_version: ENV.fetch("THEME_REVISION"))
  abort "Import did not create a theme component" unless remote.theme.component?
  puts "Admin imported #{remote.theme.name} from Git at #{remote.local_version}"
ensure
  key.destroy!
end
