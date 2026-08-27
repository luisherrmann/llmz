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
    never the content itself. pageIndex/rects (a chunk's PDF location) live
    ONLY in each kind's own JSON disk cache, not here -- benchmarked writing
    them to this table (subprocess + sqlite insert) against a plain JSON
    file write for the same data and JSON won -- 60-100x faster to write, and
    even to read back (a `python3 db.py` subprocess's fixed per-invocation
    cost dwarfs an indexed SQL lookup at this table's current size).
    `created_at`/`updated_at` are ISO 8601 UTC strings, set automatically
    (see _connect's own comment) -- nothing in this script sets them
    explicitly.
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
    # Some Python builds' sqlite3 module is compiled without loadable-
    # extension support at all (both methods missing outright rather than
    # raising) -- notably pyenv-built interpreters compiled against a
    # SQLite without that API, and macOS's /usr/bin/python3. sqlite_vec.load
    # below calls load_extension() unconditionally, so without this check
    # the failure would surface as a bare "'Connection' object has no
    # attribute 'load_extension'" with no indication of the actual cause or
    # fix. python-setup.js's _findPython3 is supposed to screen candidates
    # for this before a venv is ever built from them, so hitting this here
    # means an existing venv predates that check.
    if not (hasattr(db, 'enable_load_extension') and hasattr(db, 'load_extension')):
        raise RuntimeError(
            f'{sys.executable} was built without SQLite loadable-extension '
            'support, so sqlite-vec cannot be loaded. Delete the venv '
            '(rm -rf the "venv" folder next to this script\'s data '
            'directory) and re-run setup so it picks a working Python '
            '(e.g. Homebrew\'s python3), not this one.'
        )
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


# Input: { embedding: [float, ...], top_k, paper_id?, exclude_paper_id?, source?, sources? }
# Output: { results: [{ id, paper_id, source, source_id, distance }, ...] },
#   sorted by distance ascending (cosine distance, i.e. 1 - cosine similarity
#   -- 0 is identical, 2 is opposite), length <= top_k.
#
# paper_id/exclude_paper_id/source, if given, restrict which rowids the vec0
# MATCH search is even allowed to consider (via `rowid IN (subquery)` against
# the separate `embeddings` table, which is where they actually live -- not
# in the vec0 table itself) -- applied BEFORE the nearest-neighbor search
# runs, not as a post-filter on an over-fetched candidate window. Used to
# instead over-fetch CANDIDATE_MULTIPLIER * top_k unfiltered neighbors and
# filter/trim afterward, which could silently miss a true top-k match
# whenever more than that many non-matching vectors ranked closer to the
# query than every matching one did -- confirmed concretely as a real,
# not just theoretical, failure: `exclude_paper_id` is core/citation.js's
# getCrossLibraryChunks searching every OTHER paper for the CURRENTLY OPEN
# one's own question, so the excluded paper's own rows are usually the
# closest possible match to the query by far, and a single paper's own rows
# were found to exceed 1000 in a real library -- enough to fill the entire
# old fixed-size candidate window on their own and starve out every
# genuinely relevant OTHER paper's match. Pre-filtering has no such blind
# spot (the search only ever ranks among rows that were already allowed),
# and was confirmed empirically to cost ~10-15% over a plain unfiltered
# MATCH at this table's actual size (sqlite-vec has no partition/metadata
# index on this table to exploit either way -- both paths brute-force the
# distance computation, so restricting the candidate rowid set up front
# doesn't add a second full pass, unlike the old over-fetch-then-filter
# shape did for a wide window).
def _query_one(db, top_k, embedding, paper_id, exclude_paper_id, source, sources=None):
    query_vec = sqlite_vec.serialize_float32(embedding)

    where = []
    params = []
    if paper_id is not None:
        where.append('paper_id = ?')
        params.append(paper_id)
    if exclude_paper_id is not None:
        where.append('paper_id != ?')
        params.append(exclude_paper_id)
    if source is not None:
        where.append('source = ?')
        params.append(source)
    if sources is not None:
        # Restricts to ANY of several kinds at once (e.g. citation.js's
        # getCrossLibraryChunks searching only table/figure/equation
        # excerpts, not prose) -- a separate param from `source` above
        # (exactly one kind) rather than one param accepting either a
        # string or a list, so the input shape stays predictable on the JS
        # side (see embeddings-db.js's own comment). Giving both `source`
        # and `sources` together just ANDs two WHERE clauses, which is
        # never useful (the singular one would already subsume or
        # contradict the list) -- not validated against, since no caller
        # does this.
        placeholders = ','.join('?' * len(sources))
        where.append(f'source IN ({placeholders})')
        params.extend(sources)

    if where:
        allowed_sql = f'SELECT id FROM embeddings WHERE {" AND ".join(where)}'
        candidates = db.execute(
            f'SELECT rowid, distance FROM {VEC_TABLE} WHERE embedding MATCH ? AND rowid IN ({allowed_sql}) ORDER BY distance LIMIT ?',
            [query_vec, *params, top_k]
        ).fetchall()
    else:
        candidates = db.execute(
            f'SELECT rowid, distance FROM {VEC_TABLE} WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
            [query_vec, top_k]
        ).fetchall()
    if not candidates:
        return []

    # Already the true top_k (in distance order) at this point -- this
    # second query is a plain metadata lookup (paper_id/source/source_id
    # for the matched ids), not a further filter/trim, so no `[:top_k]`
    # slice is needed afterward the way the old over-fetch shape's
    # subsequent SQL filter step needed one.
    distance_by_id = {row_id: distance for row_id, distance in candidates}
    placeholders = ','.join('?' * len(distance_by_id))
    rows = db.execute(
        f'SELECT id, paper_id, source, source_id FROM embeddings WHERE id IN ({placeholders})',
        list(distance_by_id.keys())
    ).fetchall()

    results = [
        {'id': row_id, 'paper_id': p_id, 'source': s, 'source_id': s_id, 'distance': distance_by_id[row_id]}
        for row_id, p_id, s, s_id in rows
    ]
    results.sort(key=lambda r: r['distance'])
    return results


def _cmd_query(db, data):
    if _get_or_create_table(db) is None:
        return {'results': []}  # nothing has ever been embedded into this file
    results = _query_one(
        db, data['top_k'], data['embedding'],
        data.get('paper_id'), data.get('exclude_paper_id'), data.get('source'), data.get('sources')
    )
    return {'results': results}


# Input: { queries: [{ embedding, top_k, paper_id?, exclude_paper_id?,
#   source?, sources? }, ...] }
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
            q.get('paper_id'), q.get('exclude_paper_id'), q.get('source'), q.get('sources')
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


# Input: { paper_id, sources: { "<source>": {"delete": [source_id, ...]}
#                             | {"keep":   [source_id, ...]} } }
# Output: { deleted: int, remapped: int }
#
# Drops specific rows for a paper, and (for `keep`) renumbers whatever
# survives. Exists because two different source_id conventions coexist in
# this table (see core/document/preformatted.js's own deduplication):
#   - "delete": the source_id is a STABLE id (table_id, equation_id), so
#     removing some rows leaves the rest addressable exactly as before --
#     just drop the listed ones.
#   - "keep": the source_id is an ARRAY INDEX into the caller's own cached
#     array (sentence/paragraph/heading/preformatted_*), so removing an
#     entry shifts every later one. `keep` is the surviving source_ids IN
#     THEIR NEW ORDER: anything absent is deleted, and each survivor is
#     renumbered to its POSITION in that list. That re-keys the existing
#     vectors in place rather than re-embedding them -- the vectors live in
#     the vec0 virtual table keyed by rowid, untouched here; only the plain
#     table's own source_id column moves.
#
# Renumbering updates by primary key rather than by (paper_id, source,
# source_id): mapping e.g. 5 -> 4 while row 4 still holds source_id 4 would
# otherwise leave two rows briefly sharing a source_id (there is no unique
# constraint to catch it), and the next update for 4 would then match BOTH.
# Reading the rows up front and writing back by `id` avoids that entirely.
def _cmd_compact(db, data):
    paper_id = data['paper_id']
    deleted = 0
    remapped = 0

    def drop(row_ids):
        if not row_ids:
            return 0
        placeholders = ','.join('?' * len(row_ids))
        db.execute(f'DELETE FROM {VEC_TABLE} WHERE rowid IN ({placeholders})', row_ids)
        db.execute(f'DELETE FROM embeddings WHERE id IN ({placeholders})', row_ids)
        return len(row_ids)

    for source, spec in (data.get('sources') or {}).items():
        rows = db.execute(
            'SELECT id, source_id FROM embeddings WHERE paper_id = ? AND source = ?',
            [paper_id, source],
        ).fetchall()
        if not rows:
            continue

        if 'delete' in spec:
            doomed = set(spec['delete'])
            deleted += drop([row_id for (row_id, source_id) in rows if source_id in doomed])
            continue

        if 'keep' in spec:
            keep = spec['keep']
            new_index = {source_id: position for position, source_id in enumerate(keep)}
            deleted += drop([row_id for (row_id, source_id) in rows if source_id not in new_index])
            for row_id, source_id in rows:
                target = new_index.get(source_id)
                if target is not None and target != source_id:
                    db.execute('UPDATE embeddings SET source_id = ? WHERE id = ?', [target, row_id])
                    remapped += 1

    db.commit()
    return {'deleted': deleted, 'remapped': remapped}


COMMANDS = {
    'insert': _cmd_insert,
    'query': _cmd_query,
    'query_batch': _cmd_query_batch,
    'delete': _cmd_delete,
    'has': _cmd_has,
    'compact': _cmd_compact,
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
