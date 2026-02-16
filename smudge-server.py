"""
Smudge API — spatial comment system backed by SQLite.

  GET    /api/comments?page={slug}  — all comments for a page
  POST   /api/index                 — index an ATProto comment
  DELETE /api/index                 — remove an ATProto comment
  POST   /api/comment               — submit an anonymous comment
  DELETE /api/comment               — delete an anonymous comment (token required)

Page is identified by a simple slug (e.g. "movieingOut", "housewarming").
"""

import os
import re
import time
import uuid
import hashlib
import sqlite3
from flask import Flask, request, jsonify, g
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

DATA_DIR = os.environ.get('SMUDGE_DATA_DIR', os.path.join(os.path.dirname(__file__), 'data'))
DB_PATH = os.path.join(DATA_DIR, 'smudge.db')

# Rate limiting: max anonymous comments per IP within the window
RATE_LIMIT = int(os.environ.get('SMUDGE_RATE_LIMIT', '5'))
RATE_WINDOW = int(os.environ.get('SMUDGE_RATE_WINDOW', '60'))  # seconds

os.makedirs(DATA_DIR, exist_ok=True)


def _safe_slug(slug):
    return re.sub(r'[^a-zA-Z0-9_-]', '_', slug) or 'index'


def get_db():
    """Per-request database connection."""
    if 'smudge_db' not in g:
        g.smudge_db = sqlite3.connect(DB_PATH)
        g.smudge_db.row_factory = sqlite3.Row
        g.smudge_db.execute('PRAGMA journal_mode=WAL')
        g.smudge_db.execute('PRAGMA foreign_keys=ON')
    return g.smudge_db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop('smudge_db', None)
    if db is not None:
        db.close()


def init_db():
    """Create tables if they don't exist."""
    db = sqlite3.connect(DB_PATH)
    db.execute('''CREATE TABLE IF NOT EXISTS comments (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        page          TEXT NOT NULL,
        source        TEXT NOT NULL,  -- 'atproto' or 'anon'
        did           TEXT,
        rkey          TEXT,
        text          TEXT NOT NULL,
        position_x    INTEGER NOT NULL DEFAULT 0,
        position_y    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        handle        TEXT,
        author        TEXT,
        email_hash    TEXT,
        reply_to      TEXT,
        delete_token  TEXT,
        ip            TEXT,
        UNIQUE(did, rkey)  -- deduplicate ATProto comments
    )''')
    db.execute('''CREATE INDEX IF NOT EXISTS idx_comments_page
                  ON comments(page)''')
    db.commit()
    db.close()


init_db()


def _client_ip():
    return request.headers.get('X-Forwarded-For', request.remote_addr or '').split(',')[0].strip()


def _check_rate_limit(db, ip):
    """Returns True if the request is within limits."""
    cutoff = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(time.time() - RATE_WINDOW))
    row = db.execute(
        "SELECT COUNT(*) FROM comments WHERE source='anon' AND ip=? AND created_at > ?",
        (ip, cutoff)
    ).fetchone()
    return row[0] < RATE_LIMIT


def _hash_email(email):
    """MD5 hash of lowercased email for avatar generation."""
    if not email:
        return ''
    return hashlib.md5(email.strip().lower().encode()).hexdigest()


@app.route('/api/comments', methods=['GET'])
def get_comments():
    page = request.args.get('page', '')
    if not page:
        return jsonify({'error': 'missing ?page= parameter'}), 400

    slug = _safe_slug(page)
    db = get_db()
    rows = db.execute(
        'SELECT * FROM comments WHERE page=? ORDER BY created_at ASC', (slug,)
    ).fetchall()

    results = []
    for r in rows:
        c = {
            'id': r['id'],
            'page': r['page'],
            'source': r['source'],
            'text': r['text'],
            'positionX': r['position_x'],
            'positionY': r['position_y'],
            'createdAt': r['created_at'],
        }
        if r['source'] == 'atproto':
            c['did'] = r['did']
            c['rkey'] = r['rkey']
            c['handle'] = r['handle'] or ''
        else:
            c['author'] = r['author'] or ''
            c['hash'] = r['email_hash'] or ''
        if r['reply_to']:
            if r['source'] == 'atproto':
                c['replyTo'] = r['reply_to']
            else:
                c['parent'] = int(r['reply_to']) if r['reply_to'].isdigit() else None
        results.append(c)

    return jsonify(results)


@app.route('/api/index', methods=['POST', 'DELETE'])
def index_comment():
    """ATProto comment indexing."""
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()

    if request.method == 'DELETE':
        for field in ['did', 'rkey', 'page']:
            if field not in data:
                return jsonify({'error': f'missing field: {field}'}), 400
        slug = _safe_slug(data['page'])
        cur = db.execute(
            'DELETE FROM comments WHERE page=? AND did=? AND rkey=?',
            (slug, data['did'], data['rkey'])
        )
        db.commit()
        return jsonify({'ok': True, 'removed': cur.rowcount})

    required = ['did', 'rkey', 'page', 'text', 'positionX', 'positionY', 'createdAt']
    missing = [k for k in required if k not in data]
    if missing:
        return jsonify({'error': f'missing fields: {missing}'}), 400

    slug = _safe_slug(data['page'])
    db.execute('''INSERT OR REPLACE INTO comments
        (page, source, did, rkey, text, position_x, position_y, created_at, handle, reply_to)
        VALUES (?, 'atproto', ?, ?, ?, ?, ?, ?, ?, ?)''',
        (slug, data['did'], data['rkey'], data['text'],
         data['positionX'], data['positionY'], data['createdAt'],
         data.get('handle', ''), data.get('replyTo'))
    )
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/comment', methods=['POST', 'DELETE'])
def anon_comment():
    """Anonymous comment submission and deletion."""
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()

    if request.method == 'DELETE':
        comment_id = data.get('id')
        token = data.get('token', '')
        if not comment_id or not token:
            return jsonify({'error': 'missing id or token'}), 400

        row = db.execute(
            'SELECT delete_token FROM comments WHERE id=? AND source=?',
            (comment_id, 'anon')
        ).fetchone()

        if not row or row['delete_token'] != token:
            return jsonify({'error': 'invalid token'}), 403

        db.execute('DELETE FROM comments WHERE id=?', (comment_id,))
        db.commit()
        return jsonify({'ok': True})

    # POST — new anonymous comment
    required = ['page', 'text', 'positionX', 'positionY']
    missing = [k for k in required if k not in data]
    if missing:
        return jsonify({'error': f'missing fields: {missing}'}), 400

    ip = _client_ip()
    if not _check_rate_limit(db, ip):
        return jsonify({'error': 'too many comments, try again later'}), 429

    slug = _safe_slug(data['page'])
    token = uuid.uuid4().hex
    created_at = data.get('createdAt') or time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())

    cur = db.execute('''INSERT INTO comments
        (page, source, text, position_x, position_y, created_at,
         author, email_hash, reply_to, delete_token, ip)
        VALUES (?, 'anon', ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (slug, data['text'], data['positionX'], data['positionY'],
         created_at, data.get('author', ''), _hash_email(data.get('email', '')),
         str(data['parent']) if data.get('parent') else None,
         token, ip)
    )
    db.commit()

    return jsonify({
        'ok': True,
        'id': cur.lastrowid,
        'token': token,
        'hash': _hash_email(data.get('email', '')),
    })


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Smudge API server')
    parser.add_argument('--port', type=int, default=5000)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=True)
