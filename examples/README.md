# Configuration examples

`minimal.yml` is a Cordis patch fragment for the tested DSH profile. Install the plugin first, then apply or merge the fragment into the profile configuration.

Keep the TypeSafe key in the `TYPESAFE_API_KEY` environment variable. Do not commit it to the configuration file.

For a smaller DeepSeek context window, configure `models[].contextWindow` on the provider's matching model entry; `defaultContextWindow` does not override catalog entries that already define a window.
