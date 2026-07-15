#!/usr/bin/env python3
"""
Consolidated sqlite-vec-backed store for every paper's own embeddings
(citation sentences/paragraphs, and any other embedded source -- figures,
notes, etc.) -- replaces the old one-JSON-file-per-item-per-kind cache under
LLMz/cache/citation/ with a single database at LLMz/cache/embeddings.sqlite,
shared across the whole library. Called from core/llm/embeddings-db.js
(LLMEmbeddingsDB), which owns deployment/venv resolution the same way
document/figures.js does for its own Python scripts.

Schema:
  embeddings(id, paper_id, model, source, source_id, created_at, updated_at)
    -- one row per embedded chunk, regardless of model. `paper_id` is
    item.id -- the same numeric Zotero itemID every OTHER cache in this
    plugin already keys its own per-item file on (see e.g.
    LLMCitation._cacheDir's own `${item.id}-sentence.json`) -- kept
    consistent here rather than introducing a second identifier scheme
    (e.g. libraryKey) that the rest of the codebase doesn't use. `source`
    names what kind of thing this is ("sentence", "paragraph", "figure",
    "note", ...) and `source_id` is that source's OWN index into whatever
    cache file actually holds the text/content itself (e.g. a citation
    sentence's position in LLMCitation's own chunk list) -- this table
    only ever stores the embedding + enough to look the real content back
    up, never the content itself. `created_at`/`updated_at` are ISO 8601
    UTC strings, set automatically (see _connect's own comment) -- nothing
    in this script sets them explicitly.
  vec_<model hash>(rowid, embedding) -- one vec0 virtual table PER MODEL,
    not one shared table, since sqlite-vec's vec0 requires a FIXED vector
    dimension per table and different embedding models produce different-
    sized vectors. `rowid` here is always the SAME value as the matching
    row's `id` in `embeddings` (set explicitly on insert, never left to
    autoincrement on its own), so the two tables join 1:1 on
    embeddings.id = vec_<hash>.rowid.
  models(model, table_name, dims) -- tracks which vec0 table (and vector
    dimension) backs each model, so a later insert/query for that model
    doesn't need to re-derive the table name or guess the dimension.

Usage: python3 db.py <db_path> <command> <input_json_path> <output_json_path>
  <command> is one of: insert, query, delete, has. See _cmd_* below for each
  command's exact input/output JSON shape.
"""

import sys
import json
import sqlite3
import hashlib

try:
    import sqlite_vec
except ImportError:
    print(f'sqlite-vec not installed for {sys.executable}. Run: {sys.executable} -m pip install sqlite-vec', file=sys.stderr)
    sys.exit(2)


def _connect(db_path):
    db = sqlite3.connect(db_path)
    # WAL + a real busy_timeout -- this file is hit by several concurrent
    # `db.py` subprocess invocations at once during e.g. Index All's own
    # worker pool (see ui/advanced.js's runIndexAll, CONCURRENCY_LEVEL
    # papers in flight together), each a SEPARATE process opening/closing
    # its own connection. WAL lets concurrent readers proceed alongside a
    # writer instead of blocking outright, and busy_timeout makes a writer
    # that DOES collide with another writer wait/retry for up to 5s rather
    # than failing immediately with "database is locked".
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA busy_timeout=5000')
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)
    # created_at is set once, on insert, and never touched again.
    # updated_at starts equal to created_at and is bumped automatically by
    # the trigger below on any FUTURE update to that row -- there's no
    # UPDATE path yet (_cmd_insert only ever inserts new rows), but this
    # makes it correct-by-construction for whenever one's added (e.g. a
    # future upsert-on-re-embed), rather than depending on every future
    # UPDATE statement remembering to set it by hand. Both stored as
    # ISO 8601 UTC strings (T separator, Z suffix) rather than SQLite's own
    # CURRENT_TIMESTAMP format (space-separated, no "Z") so JS's own
    # `new Date(string)` parses them with no extra munging.
    db.execute('''
        CREATE TABLE IF NOT EXISTS embeddings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_id INTEGER NOT NULL,
            model TEXT NOT NULL,
            source TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
    ''')
    db.execute('CREATE INDEX IF NOT EXISTS idx_embeddings_paper ON embeddings(paper_id)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_embeddings_paper_model_source ON embeddings(paper_id, model, source)')
    # AFTER UPDATE (not BEFORE) so it fires once the triggering update has
    # already landed, then re-updates just the touched row -- safe against
    # an infinite loop even though the trigger body itself issues another
    # UPDATE on the same table, since SQLite doesn't re-fire a trigger from
    # within its own execution unless PRAGMA recursive_triggers is turned
    # on (it isn't, here).
    db.execute('''
        CREATE TRIGGER IF NOT EXISTS trg_embeddings_updated_at
        AFTER UPDATE ON embeddings
        FOR EACH ROW
        BEGIN
            UPDATE embeddings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
        END
    ''')
    db.execute('''
        CREATE TABLE IF NOT EXISTS models (
            model TEXT PRIMARY KEY,
            table_name TEXT NOT NULL,
            dims INTEGER NOT NULL
        )
    ''')
    return db


# vec0 table names can't safely be built from the model string directly
# (provider/model names routinely contain "/", ".", "-", which aren't valid
# in an unquoted SQL identifier) -- a short hash sidesteps quoting/escaping
# entirely, at the cost of the table name itself not being human-readable
# (not a problem, nothing ever needs to read it directly; the `models`
# table is the only thing that looks it up).
def _table_name_for_model(model):
    return 'vec_' + hashlib.sha256(model.encode('utf-8')).hexdigest()[:16]


# Returns (table_name, dims) for `model`, creating its vec0 table (and
# registering it in `models`) on first use. `dims`, when given, is the
# dimension of the vector about to be inserted -- checked against whatever
# was already registered for this model, since two DIFFERENT dimensions
# under the same model name would mean the model's own output shape
# changed (or the caller passed the wrong model string) and silently
# inserting into a table sized for the OLD dimension would corrupt that
# table's vectors, not just this one row.
def _get_or_create_model_table(db, model, dims=None):
    row = db.execute('SELECT table_name, dims FROM models WHERE model = ?', [model]).fetchone()
    if row:
        table_name, existing_dims = row
        if dims is not None and dims != existing_dims:
            raise ValueError(f'model {model!r} is already registered with dims={existing_dims}, got dims={dims}')
        return table_name, existing_dims
    if dims is None:
        return None, None
    table_name = _table_name_for_model(model)
    db.execute(f'CREATE VIRTUAL TABLE IF NOT EXISTS {table_name} USING vec0(embedding float[{dims}] distance_metric=cosine)')
    db.execute('INSERT INTO models(model, table_name, dims) VALUES (?, ?, ?)', [model, table_name, dims])
    return table_name, dims


# Input: { model, items: [{ paper_id, source, source_id, embedding: [float, ...] }, ...] }
# Output: { ids: [int, ...] } -- one id per input item, same order.
def _cmd_insert(db, data):
    model = data['model']
    items = data['items']
    ids = []
    table_name = None
    for item in items:
        embedding = item['embedding']
        if table_name is None:
            table_name, _dims = _get_or_create_model_table(db, model, len(embedding))
        cursor = db.execute(
            'INSERT INTO embeddings(paper_id, model, source, source_id) VALUES (?, ?, ?, ?)',
            [item['paper_id'], model, item['source'], item['source_id']]
        )
        row_id = cursor.lastrowid
        db.execute(
            f'INSERT INTO {table_name}(rowid, embedding) VALUES (?, ?)',
            [row_id, sqlite_vec.serialize_float32(embedding)]
        )
        ids.append(row_id)
    db.commit()
    return {'ids': ids}


# Input: { model, embedding: [float, ...], top_k, paper_id?, source? }
# Output: { results: [{ id, paper_id, model, source, source_id, distance }, ...] },
#   sorted by distance ascending (cosine distance, i.e. 1 - cosine similarity
#   -- 0 is identical, 2 is opposite), length <= top_k.
#
# paper_id/source, if given, are NOT pushed into the vec0 MATCH query itself
# (they live in the separate `embeddings` table, not the vec0 one) -- instead
# this over-fetches CANDIDATE_MULTIPLIER * top_k nearest neighbors first (or
# top_k itself if unfiltered) and filters/trims in SQL after joining back to
# `embeddings`. At this plugin's actual scale (one person's library, not a
# web-scale index) that's simpler and plenty fast; it CAN in principle miss
# a true top-k match if more than CANDIDATE_LIMIT non-matching vectors rank
# closer to the query than every matching one does, which is only a
# realistic risk for a query that matches a tiny fraction of a very large
# library.
CANDIDATE_MULTIPLIER = 20
CANDIDATE_LIMIT_FLOOR = 200


def _cmd_query(db, data):
    model = data['model']
    top_k = data['top_k']
    paper_id = data.get('paper_id')
    source = data.get('source')

    table_name, _dims = _get_or_create_model_table(db, model)
    if table_name is None:
        return {'results': []}  # nothing has ever been embedded under this model

    filtered = paper_id is not None or source is not None
    candidate_limit = max(top_k * CANDIDATE_MULTIPLIER, CANDIDATE_LIMIT_FLOOR) if filtered else top_k
    query_vec = sqlite_vec.serialize_float32(data['embedding'])

    candidates = db.execute(
        f'SELECT rowid, distance FROM {table_name} WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
        [query_vec, candidate_limit]
    ).fetchall()
    if not candidates:
        return {'results': []}

    distance_by_id = {row_id: distance for row_id, distance in candidates}
    placeholders = ','.join('?' * len(distance_by_id))
    where = [f'id IN ({placeholders})']
    params = list(distance_by_id.keys())
    if paper_id is not None:
        where.append('paper_id = ?')
        params.append(paper_id)
    if source is not None:
        where.append('source = ?')
        params.append(source)
    rows = db.execute(
        f'SELECT id, paper_id, model, source, source_id FROM embeddings WHERE {" AND ".join(where)}',
        params
    ).fetchall()

    results = [
        {'id': row_id, 'paper_id': p_id, 'model': m, 'source': s, 'source_id': s_id, 'distance': distance_by_id[row_id]}
        for row_id, p_id, m, s, s_id in rows
    ]
    results.sort(key=lambda r: r['distance'])
    return {'results': results[:top_k]}


# Input: { paper_id, model?, source? }
# Output: { deleted: int }
def _cmd_delete(db, data):
    paper_id = data['paper_id']
    model = data.get('model')
    source = data.get('source')

    where = ['paper_id = ?']
    params = [paper_id]
    if model is not None:
        where.append('model = ?')
        params.append(model)
    if source is not None:
        where.append('source = ?')
        params.append(source)
    where_clause = ' AND '.join(where)

    rows = db.execute(f'SELECT id, model FROM embeddings WHERE {where_clause}', params).fetchall()
    if not rows:
        return {'deleted': 0}

    # Grouped by model -- each model's rows live in a DIFFERENT vec0 table,
    # so the rowid deletes have to be issued per-table, not in one query.
    ids_by_model = {}
    for row_id, row_model in rows:
        ids_by_model.setdefault(row_model, []).append(row_id)
    for row_model, ids in ids_by_model.items():
        table_name, _dims = _get_or_create_model_table(db, row_model)
        placeholders = ','.join('?' * len(ids))
        db.execute(f'DELETE FROM {table_name} WHERE rowid IN ({placeholders})', ids)

    db.execute(f'DELETE FROM embeddings WHERE {where_clause}', params)
    db.commit()
    return {'deleted': len(rows)}


# Input: { paper_id, model, source? }
# Output: { has: bool, count: int }
def _cmd_has(db, data):
    where = ['paper_id = ?', 'model = ?']
    params = [data['paper_id'], data['model']]
    source = data.get('source')
    if source is not None:
        where.append('source = ?')
        params.append(source)
    count = db.execute(f'SELECT COUNT(*) FROM embeddings WHERE {" AND ".join(where)}', params).fetchone()[0]
    return {'has': count > 0, 'count': count}


COMMANDS = {
    'insert': _cmd_insert,
    'query': _cmd_query,
    'delete': _cmd_delete,
    'has': _cmd_has,
}


def main():
    if len(sys.argv) != 5:
        print('Usage: db.py <db_path> <command> <input_json_path> <output_json_path>', file=sys.stderr)
        sys.exit(1)
    db_path, command, input_path, output_path = sys.argv[1:]

    if command not in COMMANDS:
        print(f'Unknown command {command!r}, expected one of: {", ".join(COMMANDS)}', file=sys.stderr)
        sys.exit(1)

    with open(input_path) as f:
        data = json.load(f)

    db = _connect(db_path)
    try:
        result = COMMANDS[command](db, data)
    finally:
        db.close()

    with open(output_path, 'w') as f:
        json.dump(result, f)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)
