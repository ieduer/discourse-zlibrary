# frozen_string_literal: true

DiscourseZlibrary::Engine.routes.draw do
  get "/z-library" => "books#index"
  post "/z-library/search" => "books#search"
  post "/z-library/download" => "books#download"
end

Discourse::Application.routes.draw { mount ::DiscourseZlibrary::Engine, at: "/" }
