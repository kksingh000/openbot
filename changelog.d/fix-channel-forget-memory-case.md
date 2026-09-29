### Fixed

- `channel_forget_memory` now matches the saved memory text regardless of letter case. Before this
  fix, forgetting a channel memory with different casing than the saved text (for example asking to
  forget "use bun for scripts" when the saved text was "Use Bun for scripts") silently failed and
  left the memory in place.
