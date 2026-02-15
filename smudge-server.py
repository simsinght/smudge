"""
Smudge API — spatial ATProto comment index.

  GET    /api/comments?page={slug}  — returns all indexed comments for a page
  POST   /api/index                 — indexes a new comment
  DELETE /api/index                 — removes a comment from the index

Page is identified by a simple slug (e.g. "movieingOut", "housewarming").

Optional Isso integration: set ISSO_URL env var to merge anonymous comments.
"""

import os
import re
import json
import urllib.request
import urllib.parse
from flask import Flask, request, jsonify

app = Flask(__name__)

DATA_DIR = os.environ.get('SMUDGE_DATA_DIR', os.path.join(os.path.dirname(__file__), 'data'))
COMMENTS_DIR = os.path.join(DATA_DIR, 'comments')
ISSO_URL = os.environ.get('ISSO_URL', '')

os.makedirs(COMMENTS_DIR, exist_ok=True)


def _safe_slug(slug):
    """Sanitize a slug for use as a filename."""
    return re.sub(r'[^a-zA-Z0-9_-]', '_', slug) or 'index'


def _load_comments(slug):
    filepath = os.path.join(COMMENTS_DIR, f'{slug}.json')
    if os.path.exists(filepath):
        with open(filepath, 'r') as f:
            return json.load(f)
    return []


def _save_comments(slug, comments):
    filepath = os.path.join(COMMENTS_DIR, f'{slug}.json')
    tmp = filepath + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(comments, f, indent=2)
    os.replace(tmp, filepath)


def _fetch_isso_comments(page_slug):
    """Fetch anonymous comments from an Isso instance, if configured."""
    if not ISSO_URL:
        return []
    # Isso uses path-style URIs
    uri = f'/{page_slug}'
    api_url = f'{ISSO_URL}/?uri={urllib.parse.quote(uri)}'
    try:
        req = urllib.request.Request(api_url, headers={
            'Accept': 'application/json',
            'User-Agent': 'smudge-server/1.0',
        })
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        app.logger.warning(f'[smudge] isso fetch failed ({api_url}): {e}')
        return []

    results = []
    for reply in data.get('replies', []):
        pos_x, pos_y = 0, 0
        website = reply.get('website', '') or ''
        m = re.match(r'pos:(\d+),(\d+)', website) or \
            re.match(r'https?://smudge\.pos/(\d+)/(\d+)', website)
        if m:
            pos_x, pos_y = int(m.group(1)), int(m.group(2))
        results.append({
            'source': 'isso',
            'id': reply.get('id'),
            'text': re.sub(r'<[^>]+>', '', reply.get('text', '')).strip(),
            'positionX': pos_x,
            'positionY': pos_y,
            'createdAt': reply.get('created', 0),
            'author': reply.get('author'),
        })
    return results


@app.route('/api/comments', methods=['GET'])
def get_comments():
    page = request.args.get('page', '')
    if not page:
        return jsonify({'error': 'missing ?page= parameter'}), 400

    slug = _safe_slug(page)
    atproto = _load_comments(slug)
    for c in atproto:
        c.setdefault('source', 'atproto')

    isso = _fetch_isso_comments(slug)
    return jsonify(atproto + isso)



@app.route('/api/index', methods=['POST', 'DELETE'])
def index_comment():
    data = request.get_json(force=True, silent=True) or {}

    if request.method == 'DELETE':
        for field in ['did', 'rkey', 'page']:
            if field not in data:
                return jsonify({'error': f'missing field: {field}'}), 400
        slug = _safe_slug(data['page'])
        comments = _load_comments(slug)
        key = (data['did'], data['rkey'])
        before = len(comments)
        comments = [c for c in comments if (c.get('did'), c.get('rkey')) != key]
        _save_comments(slug, comments)
        return jsonify({'ok': True, 'removed': before - len(comments)})

    required = ['did', 'rkey', 'page', 'text', 'positionX', 'positionY', 'createdAt']
    missing = [k for k in required if k not in data]
    if missing:
        return jsonify({'error': f'missing fields: {missing}'}), 400

    slug = _safe_slug(data['page'])
    comments = _load_comments(slug)

    # Deduplicate by did+rkey
    key = (data['did'], data['rkey'])
    comments = [c for c in comments if (c.get('did'), c.get('rkey')) != key]

    comments.append({
        'did': data['did'],
        'rkey': data['rkey'],
        'page': data['page'],
        'text': data['text'],
        'positionX': data['positionX'],
        'positionY': data['positionY'],
        'createdAt': data['createdAt'],
        'handle': data.get('handle', ''),
        'source': 'atproto',
    })

    _save_comments(slug, comments)
    return jsonify({'ok': True})


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Smudge API server')
    parser.add_argument('--port', type=int, default=5000)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=True)
