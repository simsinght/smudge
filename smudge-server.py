"""
Smudge API — spatial comment system backed by SQLite.

  GET    /api/comments?page={slug}  — all comments for a page
  POST   /api/index                 — index an ATProto comment (pointer only)
  DELETE /api/index                 — remove an ATProto comment pointer
  POST   /api/comment               — submit an anonymous comment
  DELETE /api/comment               — delete an anonymous comment (token required)

ATProto comments are stored as thin pointers (page, did, rkey). The frontend
fetches actual content from each user's PDS at read time — your data stays yours.

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
from flask_limiter import Limiter

app = Flask(__name__)
CORS(app)

DATA_DIR = os.environ.get('SMUDGE_DATA_DIR', os.path.join(os.path.dirname(__file__), 'data'))
DB_PATH = os.path.join(DATA_DIR, 'smudge.db')

# Max text length for anonymous comments
MAX_TEXT_LENGTH = int(os.environ.get('SMUDGE_MAX_TEXT', '5000'))


def _real_ip():
    """Real client IP via proxy headers, falls back to remote_addr."""
    return request.headers.get('CF-Connecting-IP',
           request.headers.get('X-Forwarded-For', request.remote_addr or '')).split(',')[0].strip()


limiter = Limiter(
    _real_ip,
    app=app,
    storage_uri="memory://",
)

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
    # ATProto pointers — just page + did + rkey
    db.execute('''CREATE TABLE IF NOT EXISTS atproto_index (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        page  TEXT NOT NULL,
        did   TEXT NOT NULL,
        rkey  TEXT NOT NULL,
        UNIQUE(did, rkey)
    )''')
    db.execute('''CREATE INDEX IF NOT EXISTS idx_atproto_page
                  ON atproto_index(page)''')
    # Anonymous comments — full content stored server-side
    db.execute('''CREATE TABLE IF NOT EXISTS anon_comments (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        page          TEXT NOT NULL,
        text          TEXT NOT NULL,
        position_x    INTEGER NOT NULL DEFAULT 0,
        position_y    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        author        TEXT,
        email_hash    TEXT,
        reply_to      TEXT,
        delete_token  TEXT NOT NULL
    )''')
    db.execute('''CREATE INDEX IF NOT EXISTS idx_anon_page
                  ON anon_comments(page)''')
    db.commit()
    db.close()


init_db()


def _hash_email(email):
    """MD5 hash of lowercased email for avatar generation."""
    if not email:
        return ''
    return hashlib.md5(email.strip().lower().encode()).hexdigest()


@app.route('/api/comments', methods=['GET'])
@limiter.exempt
def get_comments():
    page = request.args.get('page', '')
    if not page:
        return jsonify({'error': 'missing ?page= parameter'}), 400

    slug = _safe_slug(page)
    db = get_db()

    # ATProto pointers
    atproto_rows = db.execute(
        'SELECT did, rkey FROM atproto_index WHERE page=?', (slug,)
    ).fetchall()

    # Anonymous comments (full content)
    anon_rows = db.execute(
        'SELECT * FROM anon_comments WHERE page=? ORDER BY created_at ASC', (slug,)
    ).fetchall()

    results = []

    for r in atproto_rows:
        results.append({
            'source': 'atproto',
            'did': r['did'],
            'rkey': r['rkey'],
        })

    for r in anon_rows:
        c = {
            'id': r['id'],
            'source': 'anon',
            'text': r['text'],
            'positionX': r['position_x'],
            'positionY': r['position_y'],
            'createdAt': r['created_at'],
            'author': r['author'] or '',
            'hash': r['email_hash'] or '',
        }
        if r['reply_to']:
            c['parent'] = int(r['reply_to']) if r['reply_to'].isdigit() else None
        results.append(c)

    return jsonify(results)


@app.route('/api/index', methods=['POST', 'DELETE'])
@limiter.limit("10 per minute")
def index_comment():
    """ATProto comment pointer management."""
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()

    for field in ['did', 'rkey', 'page']:
        if field not in data:
            return jsonify({'error': f'missing field: {field}'}), 400

    slug = _safe_slug(data['page'])

    if request.method == 'DELETE':
        cur = db.execute(
            'DELETE FROM atproto_index WHERE page=? AND did=? AND rkey=?',
            (slug, data['did'], data['rkey'])
        )
        db.commit()
        return jsonify({'ok': True, 'removed': cur.rowcount})

    # POST — add pointer
    db.execute('''INSERT OR IGNORE INTO atproto_index (page, did, rkey)
        VALUES (?, ?, ?)''',
        (slug, data['did'], data['rkey'])
    )
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/comment', methods=['POST', 'DELETE'])
@limiter.limit("5 per minute", methods=["POST"])
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
            'SELECT delete_token FROM anon_comments WHERE id=?',
            (comment_id,)
        ).fetchone()

        if not row or row['delete_token'] != token:
            return jsonify({'error': 'invalid token'}), 403

        db.execute('DELETE FROM anon_comments WHERE id=?', (comment_id,))
        db.commit()
        return jsonify({'ok': True})

    # POST — new anonymous comment
    required = ['page', 'text', 'positionX', 'positionY']
    missing = [k for k in required if k not in data]
    if missing:
        return jsonify({'error': f'missing fields: {missing}'}), 400

    text = data['text']
    if len(text) > MAX_TEXT_LENGTH:
        return jsonify({'error': f'text exceeds {MAX_TEXT_LENGTH} characters'}), 400

    slug = _safe_slug(data['page'])
    token = uuid.uuid4().hex
    created_at = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())

    cur = db.execute('''INSERT INTO anon_comments
        (page, text, position_x, position_y, created_at,
         author, email_hash, reply_to, delete_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (slug, text, data['positionX'], data['positionY'],
         created_at, data.get('author', ''), _hash_email(data.get('email', '')),
         str(data['parent']) if data.get('parent') else None,
         token)
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
