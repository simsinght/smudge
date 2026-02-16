# smudge

Spatial comments as oil smudge marks. Backed by [ATProto](https://atproto.com) identity with built-in anonymous fallback.

Each comment is a record (`computer.sims.smudge`) written to the commenter's own ATProto PDS. The backend stores only pointers (`page, did, rkey`) — the frontend fetches actual comment content directly from each user's PDS at read time. Your data stays yours. Anonymous comments are stored server-side with rate limiting and token-based deletion.

## How it works

```
Browser (smudge.js)              Backend (smudge-server.py)      User's PDS
       |                                 |                          |
       |-- GET /api/comments?page=slug ->|                          |
       |<-- [{did, rkey}, ...] ----------|  (pointers only)         |
       |                                 |                          |
       |-- getRecord (per did/rkey) -----|------------------------->|
       |<-- {text, posX, posY, ...} -----|--------------------------|
       |                                 |                          |
       |-- long-press → compose -------->|                          |
       |                                 |                          |
       |  ATProto path:                  |                          |
       |-- createRecord (OAuth) ---------|------------------------->|
       |<-- {uri, cid} -----------------|---------------------------|
       |-- POST /api/index {did,rkey} ->|  (stores pointer)        |
       |                                 |                          |
       |  Anonymous path:                |                          |
       |-- POST /api/comment ----------->|  (stores in SQLite,      |
       |<-- {id, token} ----------------|   returns delete token)   |
       |                                 |                          |
       |-- resolve DID → profile --------|--- public API ---------->|
```

- **Your data stays yours** — ATProto comment content is fetched from each user's PDS at read time. The backend never stores comment text for ATProto users. Delete from your PDS, it's gone everywhere.
- **Browser writes directly to the user's PDS** via OAuth — credentials never touch your server
- **The backend is a thin pointer index** — it only knows _which_ records exist on _which_ page, not what they say
- **Anonymous comments** are stored server-side with IP rate limiting (hashed), text length limits, and token-based deletion
- **Stale cleanup** — if a PDS record returns 404 (user deleted it), the frontend automatically removes the stale pointer from the index
- **No external dependencies** — no firehose, just one SQLite database

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
pip install flask flask-cors flask-limiter
python smudge-server.py
```

Or integrate the routes into your existing server — see `smudge-server.py` for the definitions. The backend provides:

- `GET /api/comments?page={slug}` — returns ATProto pointers (`{did, rkey}`) and anonymous comments
- `POST /api/index` — stores an ATProto pointer (page, did, rkey only)
- `DELETE /api/index` — removes an ATProto pointer
- `POST /api/comment` — submits an anonymous comment (returns `{id, token}`)
- `DELETE /api/comment` — deletes an anonymous comment (requires token)

Data is stored in SQLite (`smudge.db`) — two tables: `atproto_index` (pointers) and `anon_comments` (anonymous content).

#### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SMUDGE_DATA_DIR` | `./data` | Directory for the SQLite database |
| `SMUDGE_MAX_TEXT` | `5000` | Max anonymous comment length in characters |

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

## Security

- **No ATProto content stored** — the backend only stores `(page, did, rkey)` pointers. Comment text, positions, and timestamps are fetched from each user's PDS at read time.
- **Rate limiting** — anonymous comment POSTs are limited to 5/minute per IP, ATProto index writes to 10/minute per IP (via [Flask-Limiter](https://flask-limiter.readthedocs.io)). IPs are resolved from `CF-Connecting-IP` / `X-Forwarded-For` headers for correct identification behind proxies
- **Server-generated timestamps** — anonymous comment `createdAt` is set server-side to prevent rate limit bypass
- **Text length limits** — anonymous comments are capped at `SMUDGE_MAX_TEXT` characters (default 5000)
- **Token-based deletion** — anonymous comments return a uuid4 delete token; only the token holder can delete
- **Stale pointer cleanup** — PDS 404s trigger automatic index cleanup

## License

MIT
