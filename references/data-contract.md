# Browser / bridge contract

The visualization is `atlas.json`, UTF-8 JSON. Coordinates are authored, not inferred from file imports. Strings contain plain text, never HTML. Schema source: `assets/atlas.schema.json`.

```
Atlas { title, summary, revision: integer >= 0, views: View[] }
View { id, title, question, summary, width, height,
       groups: Group[], nodes: Node[], edges: Edge[], notes: string[] }
Group { id, label, x, y, width, height }
Node { id, label, kind, status, x, y, width, height,
       summary, detail, evidence: Evidence[], links: Link[] }
Edge { id, source, target, label, kind, status, detail,
       evidence: Evidence[], points: Point[] }
Evidence { path: repository-relative, start: positive integer,
           end: positive integer >= start, claim: string }
Link { view: view ID, element: element ID or empty string, label }
Point { x, y }
```

`kind` is a short semantic name, e.g. public-interface, mutable-state, artifact, execution, ownership, data, call, invalidation. `status` is one of verified, inferred, planned, blocked. `points` contains intermediate edge routing coordinates, or is empty for default routing. Node labels should be concise; put technical depth in detail and inspector evidence. Nodes and edges share a unique ID namespace within each view. Cross-view links resolve after loading the entire atlas. Use finite, positive canvas dimensions and keep every shape inside the canvas.

All JSON fields above are required. Empty arrays are permitted except atlas views. IDs are stable strings; do not rename existing IDs just to improve labels. The browser selects `{view, elements: [ID, ...]}`, including edges. Requests freeze mode, selection, question and base revision at submission.

## HTTP API (same origin, local only)

- `GET /api/state`: `{atlas, messages, busy, backend, freshness, coverage, proposals}`. `freshness[viewId]` contains `status: fresh | stale | unknown | unavailable`, `changed_paths`, `unavailable_paths`, and `checked_at`. `unknown` is not a verified baseline. `coverage` explains that monitoring only covers cited files.
- `POST /api/ask`: existing `{mode: "qa" | "edit", view, elements: string[], question, revision}` plus optional `preview: boolean`, `scope: "elements" | "view"`, `permitted_neighbors: string[]`, `allow_new_views: boolean`. Returns HTTP 202 `{job}`. Default scope is elements when selection is nonempty, otherwise view. Preview defaults false. New views default forbidden for elements, allowed for legacy view scope.
- `GET /api/jobs/<job>`: `{status: queued | running | done | preview | error, ...}`. Done includes answer/revision/warnings. Preview includes `proposal`, `base_revision`, `candidate` atlas, `diff`, `answer`, `warnings`. A diff entry contains `{view, kind, id, fields, change}`. Reload authoritative state after done/apply.
- `POST /api/apply`: `{proposal, revision}`. Only server-held proposals may be applied. Revision and referenced-file fingerprints must still match. Atomic commit uses the same validation path as automatic edits.
- `POST /api/discard`: `{proposal}`. Discard the transient candidate. Preview does not change authoritative atlas, successful chat, or undo history. Restart loses unapplied proposals; later changes may invalidate them.
- `POST /api/source-check`: `{revision}` returns `{freshness, coverage}`. Checks the already registered cited files using the constrained source reader; does not scan the repository or run hooks.
- `POST /api/refresh`: `{revision, views: string[], preview?: boolean}`. Reanalyzes only those views in sequential AI tasks, forbids new views, merges and commits once. Any failure leaves all authoritative views unchanged. Refresh can correct evidence without changing visible geometry.
- `POST /api/undo`: `{revision}` restores previous atlas and source baselines as a **new** revision; preserves messages. Missing sources are surfaced separately and do not prevent undo.
- `GET /api/source?path=<encoded-relative-path>&start=N&end=N`: bounded source excerpt `{path,start,end,text}`; only ranges explicitly present in current atlas evidence may be read. Never an unrestricted file browser.
- `GET /api/export`: current atlas as a JSON download.

Every POST requires `Content-Type: application/json` and `X-Atlas-Token`, injected in served HTML as `window.ATLAS_TOKEN`. No CORS. Origin/Host are checked. Requests have a size limit. Mutations serialize; stale revisions or concurrent operations are rejected with 409. Browser must handle non-JSON/non-2xx errors. Never switch modes for an in-flight request.

## Modification scope

Elements scope permits changes or removal of selected existing nodes/edges. Existing IDs remain stable. Removing a node requires removing incident edges and preserving valid cross-view links. Unselected elements, groups and view text cannot change. The canvas may grow but cannot shrink. Incident edges may adjust routing points without changing their meaning. Explicitly permitted one-hop neighbor nodes may change geometry only. The first scoped implementation forbids adding nodes/edges; choose view scope when decomposing or extending the graph. New explanatory views additionally require `allow_new_views`.

Scope is checked by the server against the frozen request, not merely described in the AI prompt. An out-of-scope response is rejected in full; it is never silently clipped. View scope still preserves all other existing views.

## AI response and persistence

`{answer: string, replacement_view: View | null, new_views: View[]}` constrained by `assets/response.schema.json`; the original atlas format remains compatible.

QA rejects any replacement or added views. Edit may replace only authorized views. Exact no-op edits are rejected, but evidence/detail-only corrections are legitimate. Validate structural integrity of the whole candidate and live evidence for changed citations; refresh validates all evidence in the refreshed views. Untouched stale views must not prevent recovery. Overlap checks apply to modified views rather than requiring every old view to be repaired at once.

The authoritative sidecar version is 2, storing atlas, recent chat, undo history and per-view source baselines together. Before first mutation of a loaded v1 sidecar, preserve a byte-exact v1 backup; subsequent upgrades after rollback preserve older backups and use a content-addressed filename for different v1 bytes. Undo restores the matching old baselines; it cannot mark stale evidence current merely by reverting the graph. A provider or persistence failure does not mutate authoritative memory or disk.

Source fingerprints cover cited files at request and commit boundaries. They cannot prove semantic correctness, capture every unregistered dependency, or provide an atomic filesystem snapshot. No baseline means unknown, not fresh. Refreshing one view must not clear another view's stale state.
