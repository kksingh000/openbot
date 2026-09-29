### Added

- Connect GitHub in Server settings > Connectors. Every agent on this computer then gets the GitHub
  tools, and `gh` and `git` sign in as you, in the repositories where you install the OpenBot GitHub
  App. The panel lists these repositories. You do not need a personal access token.
- In the repositories where you can push, GitHub shows the issues, pull requests, comments and
  commits of an agent as `openbotgit[bot]`, not as you. OpenBot gets short-lived tokens for this from
  the OpenBot account service, which keeps no token. `gh` still acts as you.
