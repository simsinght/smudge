# smudge

Spatial comments as oil smudge marks. Backed by [ATProto](https://atproto.com) identity with optional [Isso](https://isso-comments.de) anonymous fallback.

Each comment is a record (`computer.sims.smudge`) written to the commenter's own ATProto PDS. A minimal Python backend maintains an index so the frontend can fetch all comments for a page in one call. Comments appear as organic blobs scattered on the page surface, placed by users via long-press.

## How it works

```
Browser (smudge.js)              Backend (smudge-server.py)      User's PDS
       |                                 |                          |
       |-- GET /api/comments?page=slug ->|                          |
       |<-- [{text, posX, posY, did}] ---|                          |
       |                                 |                          |
       |-- long-press → compose -------->|                          |
       |-- createRecord (ATProto) -------|------------------------->|
       |   collection: computer.sims.    |                          |
       |     smudge                      |                          |
       |<-- {uri, cid} -----------------|---------------------------|
       |                                 |                          |
       |-- POST /api/index ------------->| saves to comments.json   |
       |                                 |                          |
       |-- resolve DID → profile --------|--- public API ---------->|
```

- **Browser writes directly to the user's PDS** via OAuth — credentials never touch your server
- **The backend is just an index** — source of truth is always the user's PDS repo
- **No firehose needed** — comments go through your site, so the backend knows about them at write time

## Setup

### 1. Serve the files

Drop `smudge.js`, `callback.html`, and `client-metadata.json` into a directory on your site (e.g. `/smudge/`).

### 2. Add the script tag

```html
<script type="module" src="/smudge/smudge.js"
  data-page="myPageSlug"
  data-api="https://your-backend.example.com"
  data-isso="https://comments.example.com"
  data-isso-uri="/myPageSlug"></script>
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

Or integrate the two endpoints into your existing server — see `smudge-server.py` for the route definitions. The backend provides:

- `GET /api/comments?page={slug}` — returns indexed comments
- `POST /api/index` — indexes a new comment

Comments are stored as JSON files in a `comments/` directory.

Set `ISSO_URL` environment variable to enable anonymous comment merging:

```
ISSO_URL=https://comments.example.com python smudge-server.py
```

## Config

All configuration is via `data-*` attributes on the script tag:

| Attribute | Required | Description |
|-----------|----------|-------------|
| `data-page` | yes | Page slug (e.g. `movieingOut`) |
| `data-api` | yes | Backend base URL |
| `data-oauth-client-id` | no | Path to `client-metadata.json`. Defaults to `/smudge/client-metadata.json` |
| `data-isso` | no | Isso instance URL. If omitted, anonymous option is hidden |
| `data-isso-uri` | no | Isso thread URI. Defaults to `/{page}` |
| `data-lexicon` | no | ATProto collection NSID. Defaults to `computer.sims.smudge` |

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
- **Read**: hover or click a smudge to see the comment text, author, and timestamp
- **Write**: long-press (3 seconds) anywhere on the page to compose. Choose ATProto sign-in or anonymous (if Isso is configured)
- **Anonymous nudge**: choosing anonymous triggers a gentle nudge toward creating an ATProto account

## License

MIT
