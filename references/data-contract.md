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

- `GET /api/state`: `{atlas, messages, busy, backend}`; message objects include role, content, mode, selection, revision; backend is codex.
- `POST /api/ask`: `{mode: "qa" | "edit", view, elements: string[], question, revision}` returns HTTP 202 `{job}`. Poll `GET /api/jobs/<job>`; response is `{status: queued|running|done|error, answer?, error?, revision?}`. On done, reload state; on error show the error and allow retry.
- `POST /api/undo`: `{revision}` restores the previous atlas as a **new** revision; preserves messages. Reload state.
- `GET /api/source?path=<encoded-relative-path>&start=N&end=N`: bounded source excerpt `{path,start,end,text}`; only ranges explicitly present in current atlas evidence may be read. Never an unrestricted file browser.
- `GET /api/export`: current atlas as a JSON download.

Every POST requires `Content-Type: application/json` and `X-Atlas-Token`, injected in served HTML as `window.ATLAS_TOKEN`. No CORS. Origin/Host are checked. Requests have a size limit. Mutations serialize; reject stale revisions with 409 and concurrent operations with 409. Browser must handle non-JSON / non-2xx errors. Never switch modes for an in-flight request.

## AI response

`{answer: string, replacement_view: View | null, new_views: View[]}` constrained by `assets/response.schema.json`.

QA rejects any replacement or added views. Edit may replace only the selected view and add genuinely useful explanatory views; unrelated existing views stay unchanged. Validate the whole candidate atlas before atomic persistence. History stores the previous atlas. A provider failure or invalid response does not mutate the atlas. Replacements preserve factual status, citations and stable identities where the concepts persist. AI reads the repository under a read-only sandbox; only the bridge writes visualization output.
