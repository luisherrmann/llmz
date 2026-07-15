#!/usr/bin/env python3
"""
Consolidated sqlite-vec-backed store for a paper's own embeddings -- ONE
.sqlite file PER EMBEDDING MODEL (LLMz/cache/embeddings/<model>.sqlite, see
core/llm/embeddings-db.js's _sanitizeModelName/_dbPath), not one shared file
across every model. Called from core/llm/embeddings-db.js (LLMEmbeddingsDB),
which owns deployment/venv resolution, model-name-to-filename sanitization,
and picking which file a given call routes to.

Splitting by file (rather than a single shared file with a `model` column
plus one vec0 table per model, hashed to a safe table name) means: (1)
dropping/resetting one model's embeddings entirely is a plain file delete,
no DROP TABLE/DELETE dance, and immediately reclaims disk space with no
VACUUM needed; (2) no cross-model WAL/busy_timeout contention between
concurrent Index All workers embedding under different models; (3) this
schema no longer needs a `models` registry table OR a hashed vec0 table name
at all -- a file is scoped to exactly one model, so there's exactly one vec0
table in it, always named `vec_embeddings`.

Schema (per file):
  embeddings(id, paper_id, source, source_id, created_at, updated_at)
    -- one row per embedded chunk. `paper_id` is item.id -- the same numeric
    Zotero itemID every other cache in this plugin keys its own per-item
    file on (see e.g. LLMCitation._cacheDir's own `${item.id}.json`).
    `source` names what kind of thing this is ("sentence", "paragraph",
    "figure", ...) and `source_id` is that source's OWN index into whatever
    cache file actually holds the text/content itself (e.g. a citation
    sentence's position in LLMCitation's own chunk list) -- this table only
    ever stores the embedding + enough to look the real content back up,
    never the content itself. `created_at`/`updated_at` are ISO 8601 UTC
    strings, set automatically (see _connect's own comment) -- nothing in
    this script sets them explicitly.
  vec_embeddings(rowid, embedding) -- the one vec0 virtual table this file
    has. `rowid` is always the SAME value as the matching row's `id` in
    `embeddings` (set explicitly on insert, never left to autoincrement on
    its own), so the two tables join 1:1 on embeddings.id = vec_embeddings.rowid.
  meta(dims INTEGER) -- single-row table recording the vector dimension
    vec_embeddings was created with, so a later insert with a mismatched
    dimension (e.g. a model's own output shape changed, or embeddings-db.js
    somehow resolved the wrong file for a model) is rejected rather than
    silently corrupting the table -- without needing a separate
    model-name-to-dims registry the way the old shared-file schema did
    (that registry only ever existed because one file held SEVERAL models/
    dims at once, which can't happen here by construction).

Usage: python3 db.py <db_path> <command> <input_json_path> <output_json_path>
  <command> is one of: insert, query, query_batch, delete, has. See _cmd_*
  below for each command's exact input/output JSON shape. `db_path` should
  already point at the model-specific file -- this script has no notion of
  "model" as a concept at all, purely by construction.
"""

import sys
import json
import sqlite3

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
    # than failing immediately with "database is locked". Splitting by
    # model (see module docstring) already keeps papers embedding under
    # DIFFERENT models from ever contending on the same file at all -- this
    # still matters for concurrent papers under the SAME model.
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
            source TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
    ''')
    db.execute('CREATE INDEX IF NOT EXISTS idx_embeddings_paper ON embeddings(paper_id)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_embeddings_paper_source ON embeddings(paper_id, source)')
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
    db.execute('CREATE TABLE IF NOT EXISTS meta (dims INTEGER NOT NULL)')
    return db


VEC_TABLE = 'vec_embeddings'


# Returns this file's own vector dimension (creating vec_embeddings, and
# recording `dims` in `meta`, on first use) -- or None if nothing has ever
# been embedded into this file yet. `dims`, when given, is the dimension of
# the vector about to be inserted -- checked against whatever this file was
# already created with, since a mismatch would mean the model's own output
# shape changed (or embeddings-db.js resolved the wrong file for this
# model) and silently inserting would corrupt the table, not just this one
# row.
def _get_or_create_table(db, dims=None):
    row = db.execute('SELECT dims FROM meta').fetchone()
    if row:
        existing_dims = row[0]
        if dims is not None and dims != existing_dims:
            raise ValueError(f'this embeddings file is already using dims={existing_dims}, got dims={dims}')
        return existing_dims
    if dims is None:
        return None
    db.execute(f'CREATE VIRTUAL TABLE IF NOT EXISTS {VEC_TABLE} USING vec0(embedding float[{dims}] distance_metric=cosine)')
    db.execute('INSERT INTO meta(dims) VALUES (?)', [dims])
    return dims


# Input: { items: [{ paper_id, source, source_id, embedding: [float, ...] }, ...] }
# Output: { ids: [int, ...] } -- one id per input item, same order.
def _cmd_insert(db, data):
    items = data['items']
    ids = []
    # Dimension checked/table created ONCE, off the first item, not
    # per-item -- every item in one batch is always the same model's own
    # output (see embeddings-db.js's insert(), one model per call), so
    # they all share the same dimension; a later item with a mismatched
    # dimension would just fail at its own INSERT via sqlite-vec's own
    # enforcement, same as before this was split out.
    if items:
        _get_or_create_table(db, len(items[0]['embedding']))
    for item in items:
        cursor = db.execute(
            'INSERT INTO embeddings(paper_id, source, source_id) VALUES (?, ?, ?)',
            [item['paper_id'], item['source'], item['source_id']]
        )
        row_id = cursor.lastrowid
        db.execute(
            f'INSERT INTO {VEC_TABLE}(rowid, embedding) VALUES (?, ?)',
            [row_id, sqlite_vec.serialize_float32(item['embedding'])]
        )
        ids.append(row_id)
    db.commit()
    return {'ids': ids}


# Input: { embedding: [float, ...], top_k, paper_id?, exclude_paper_id?, source? }
# Output: { results: [{ id, paper_id, source, source_id, distance }, ...] },
#   sorted by distance ascending (cosine distance, i.e. 1 - cosine similarity
#   -- 0 is identical, 2 is opposite), length <= top_k.
#
# paper_id/exclude_paper_id/source, if given, are NOT pushed into the vec0
# MATCH query itself (they live in the separate `embeddings` table, not the
# vec0 one) -- instead this over-fetches CANDIDATE_MULTIPLIER * top_k nearest
# neighbors first (or top_k itself if unfiltered) and filters/trims in SQL
# after joining back to `embeddings`. At this plugin's actual scale (one
# person's library, not a web-scale index) that's simpler and plenty fast;
# it CAN in principle miss a true top-k match if more than CANDIDATE_LIMIT
# non-matching vectors rank closer to the query than every matching one
# does, which is only a realistic risk for a query that matches a tiny
# fraction of a very large library. `exclude_paper_id` (core/citation.js's
# getCrossLibraryChunks, searching every OTHER paper for the currently open
# one's own question) is exactly as selective as `paper_id` in the OPPOSITE
# direction -- both narrow the candidate pool by one paper's worth of rows
# -- so it's treated as "filtered" the same way, widening candidate_limit
# the same way.
CANDIDATE_MULTIPLIER = 20
CANDIDATE_LIMIT_FLOOR = 200


# One nearest-neighbor lookup -- factored out of _cmd_query so
# _cmd_query_batch below can run several of these against the SAME open
# connection, one per query vector, without each needing its own db.py
# subprocess invocation. Returns a plain list (not the {'results': ...}
# wrapper), already trimmed to top_k.
def _query_one(db, top_k, embedding, paper_id, exclude_paper_id, source):
    filtered = paper_id is not None or exclude_paper_id is not None or source is not None
    candidate_limit = max(top_k * CANDIDATE_MULTIPLIER, CANDIDATE_LIMIT_FLOOR) if filtered else top_k
    query_vec = sqlite_vec.serialize_float32(embedding)

    candidates = db.execute(
        f'SELECT rowid, distance FROM {VEC_TABLE} WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
        [query_vec, candidate_limit]
    ).fetchall()
    if not candidates:
        return []

    distance_by_id = {row_id: distance for row_id, distance in candidates}
    placeholders = ','.join('?' * len(distance_by_id))
    where = [f'id IN ({placeholders})']
    params = list(distance_by_id.keys())
    if paper_id is not None:
        where.append('paper_id = ?')
        params.append(paper_id)
    if exclude_paper_id is not None:
        where.append('paper_id != ?')
        params.append(exclude_paper_id)
    if source is not None:
        where.append('source = ?')
        params.append(source)
    rows = db.execute(
        f'SELECT id, paper_id, source, source_id FROM embeddings WHERE {" AND ".join(where)}',
        params
    ).fetchall()

    results = [
        {'id': row_id, 'paper_id': p_id, 'source': s, 'source_id': s_id, 'distance': distance_by_id[row_id]}
        for row_id, p_id, s, s_id in rows
    ]
    results.sort(key=lambda r: r['distance'])
    return results[:top_k]


def _cmd_query(db, data):
    if _get_or_create_table(db) is None:
        return {'results': []}  # nothing has ever been embedded into this file
    results = _query_one(
        db, data['top_k'], data['embedding'],
        data.get('paper_id'), data.get('exclude_paper_id'), data.get('source')
    )
    return {'results': results}


# Input: { queries: [{ embedding, top_k, paper_id?, exclude_paper_id?,
#   source? }, ...] }
# Output: { results: [[{ id, paper_id, source, source_id, distance },
#   ...], ...] } -- one results array per entry in `queries`, same order.
#
# Batches at the PROCESS level, not the sqlite-vec level -- vec0's MATCH
# operator takes exactly one query vector per SQL statement (there is no
# native way to pass several query vectors into one MATCH lookup), so this
# still issues one MATCH per query internally, via the same _query_one as
# _cmd_query. What it actually saves is the FIXED per-subprocess cost --
# python startup, sqlite3/sqlite_vec imports, connect+load extension,
# measured at ~20-40ms combined, dwarfing a single MATCH query's own ~2-5ms
# -- by running every query against the SAME open connection, instead of
# one db.py subprocess invocation per query vector. Used by
# core/document/citations.js's resolvePositions embedding fallback to look
# up the nearest sentence for potentially several unresolved citations in
# one call instead of N.
def _cmd_query_batch(db, data):
    queries = data['queries']
    if _get_or_create_table(db) is None:
        return {'results': [[] for _ in queries]}
    results = [
        _query_one(
            db, q['top_k'], q['embedding'],
            q.get('paper_id'), q.get('exclude_paper_id'), q.get('source')
        )
        for q in queries
    ]
    return {'results': results}


# Input: { paper_id, source? }
# Output: { deleted: int }
def _cmd_delete(db, data):
    paper_id = data['paper_id']
    source = data.get('source')

    where = ['paper_id = ?']
    params = [paper_id]
    if source is not None:
        where.append('source = ?')
        params.append(source)
    where_clause = ' AND '.join(where)

    rows = db.execute(f'SELECT id FROM embeddings WHERE {where_clause}', params).fetchall()
    if not rows:
        return {'deleted': 0}

    ids = [row_id for (row_id,) in rows]
    placeholders = ','.join('?' * len(ids))
    db.execute(f'DELETE FROM {VEC_TABLE} WHERE rowid IN ({placeholders})', ids)
    db.execute(f'DELETE FROM embeddings WHERE {where_clause}', params)
    db.commit()
    return {'deleted': len(rows)}


# Input: { paper_id, source? }
# Output: { has: bool, count: int }
def _cmd_has(db, data):
    where = ['paper_id = ?']
    params = [data['paper_id']]
    source = data.get('source')
    if source is not None:
        where.append('source = ?')
        params.append(source)
    count = db.execute(f'SELECT COUNT(*) FROM embeddings WHERE {" AND ".join(where)}', params).fetchone()[0]
    return {'has': count > 0, 'count': count}


COMMANDS = {
    'insert': _cmd_insert,
    'query': _cmd_query,
    'query_batch': _cmd_query_batch,
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
