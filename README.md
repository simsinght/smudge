# smudge

Spatial comments as oil smudge marks. Backed by [ATProto](https://atproto.com) identity with built-in anonymous fallback.

Each comment is a record (`computer.sims.smudge`) written to the commenter's own ATProto PDS. A minimal Python backend (SQLite) handles indexing and anonymous comments. Comments appear as iridescent blobs scattered on the page surface, placed by users via long-press.

## How it works

```
Browser (smudge.js)              Backend (smudge-server.py)      User's PDS
       |                                 |                          |
       |-- GET /api/comments?page=slug ->|  (reads from SQLite)     |
       |<-- [{text, posX, posY, did}] ---|                          |
       |                                 |                          |
       |-- long-press → compose -------->|                          |
       |                                 |                          |
       |  ATProto path:                  |                          |
       |-- createRecord (OAuth) ---------|------------------------->|
       |<-- {uri, cid} -----------------|---------------------------|
       |-- POST /api/index ------------->|  (indexes in SQLite)     |
       |                                 |                          |
       |  Anonymous path:                |                          |
       |-- POST /api/comment ----------->|  (stores in SQLite,      |
       |<-- {id, token} ----------------|   returns delete token)   |
       |                                 |                          |
       |-- resolve DID → profile --------|--- public API ---------->|
```

- **Browser writes directly to the user's PDS** via OAuth — credentials never touch your server
- **The backend is an index + anonymous store** — ATProto source of truth is always the user's PDS repo
- **Anonymous comments** are stored server-side with IP rate limiting and token-based deletion
- **No external dependencies** — no Isso, no firehose, just one SQLite database

## Setup

### 1. Serve the files

Drop `smudge.js`, `callback.html`, and `client-metadata.json` into a directory on your site (e.g. `/smudge/`).

### 2. Add the script tag

```html
<script type="module" src="/smudge/smudge.js"
  data-page="myPageSlug"
  data-api="https://your-backend.example.com"
  data-oauth-client-id="/smudge/client-metadata.json"></script>
```

### 3. Configure OAuth

Edit `client-metadata.json` with your domain:

```json
{
  "client_id": "https://yoursite.com/smudge/client-metadata.json",
  "redirect_uris": ["https://yoursite.com/smudge/callback.html"],
  "client_uri": "https://yoursite.com",
  ...
}
```

The `client_id` URL must be publicly fetchable — ATProto authorization servers retrieve it to verify the client.

### 4. Run the backend

```
pip install flask flask-cors
python smudge-server.py
```

Or integrate the routes into your existing server — see `smudge-server.py` for the definitions. The backend provides:

- `GET /api/comments?page={slug}` — returns all comments for a page
- `POST /api/index` — indexes an ATProto comment
- `DELETE /api/index` — removes an ATProto comment
- `POST /api/comment` — submits an anonymous comment (returns `{id, token}`)
- `DELETE /api/comment` — deletes an anonymous comment (requires token)

Data is stored in a single SQLite database (`smudge.db`).

#### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SMUDGE_DATA_DIR` | `./data` | Directory for the SQLite database |
| `SMUDGE_RATE_LIMIT` | `5` | Max anonymous comments per IP per window |
| `SMUDGE_RATE_WINDOW` | `60` | Rate limit window in seconds |

## Config

All frontend configuration is via `data-*` attributes on the script tag:

| Attribute | Required | Description |
|-----------|----------|-------------|
| `data-page` | yes | Page slug (e.g. `movieingOut`) |
| `data-api` | yes | Backend base URL |
| `data-oauth-client-id` | no | Path to `client-metadata.json`. Defaults to `/smudge/client-metadata.json` |
| `data-lexicon` | no | ATProto collection NSID. Defaults to `computer.sims.smudge` |

Anonymous comments are automatically available when `data-api` is set. No additional configuration needed.

### Custom anonymous backend

The anonymous backend is pluggable. To replace the built-in implementation:

```js
window.smudge.setAnonBackend({
  async submit(text, x, y, { name, email, parent }) { /* POST to your API */ },
  async remove(id) { /* DELETE from your API */ },
  canRemove(comment) { /* return true if current user owns this comment */ },
  getReplyParent(replyToKey) { /* extract parent ID from key, or null */ },
});
```

## Lexicon

The custom record type `computer.sims.smudge` stored in each commenter's PDS:

```json
{
  "$type": "computer.sims.smudge",
  "text": "this page is beautiful",
  "pageUrl": "https://yoursite.com/page",
  "positionX": 450,
  "positionY": 2300,
  "createdAt": "2026-02-14T12:00:00.000Z"
}
```

The PDS accepts unknown schemas with `validationStatus: "unknown"`. The user owns their comment — they can delete it from their repo anytime.

The `data-lexicon` attribute lets you use your own NSID (e.g. `com.example.smudge`) while keeping the same record shape.

## Interaction

- **Toggle**: fixed button (bottom-right) shows/hides the smudge layer
- **List**: button to the left of toggle opens a panel listing all comments
- **Read**: hover or tap a smudge to see the comment text, author, and timestamp
- **Write**: long-press (3 seconds) anywhere on the page to compose
- **Auth choice**: sign in with ATProto (primary) or leave an anonymous mark
- **Anonymous nudge**: choosing anonymous triggers a gentle nudge toward creating an ATProto account
- **Reply**: reply to any comment from its tooltip
- **Delete**: remove your own comments (ATProto via PDS, anonymous via delete token)
- **Keyboard**: Cmd/Ctrl+Enter to submit the compose form

## License

MIT
