# TODO — restore archived provider sessions

**Status**: retention decided; restore design remains open.

`CORAL_JOBS_RETENTION_DAYS` (default 14) governs terminal scratch, whole export directories including `provider-artifacts/`, and journal progress retention. The coordinator schedules retention after startup serves and every 24 h. Live and unknown jobs stay. A directory unknown to the current journal expires only when the newest content-file mtime across its tree is older than the cutoff; directory mtimes are excluded so partial deletion can resume next cycle. Newly written content keeps the residue. A superseded epoch's independent result proof stays until that epoch is gone. Progress fault diagnostics and causal evidence remain for projection replay and shipped readers. Unknown deletion evidence keeps the subject for a later retry; backend status reports the last outcome.

Expired exports lose their preserved provider originals, so sessions older than the retention period cannot be resumed. Coral preserves these originals before removing the native copy from the provider's interactive resume picker.

A restore command is still open: it needs a user-facing session identity, a collision rule when the provider already has the same session id, and ownership and expiry for the recreated native file. Restoration must respect the settled export lifetime.
