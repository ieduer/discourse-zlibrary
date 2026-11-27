# frozen_string_literal: true

module DiscourseZlibrary
  class Engine < ::Rails::Engine
    engine_name PLUGIN_NAME
    isolate_namespace DiscourseZlibrary
  end
end
