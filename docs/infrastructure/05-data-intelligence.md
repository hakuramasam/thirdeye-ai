# 05 — Data intelligence engine

Scope: structured ingestion, document indexing, pgvector semantic search, RAG retrieval, dedupe, source
verification, retention, and agent knowledge reuse. Nothing here exists today — there is no vector
column, no `tsvector`, no embeddings table, and agents have no retrieval tool of any kind.

The design constraint that shapes everything: **retrieval must be able to answer "where did that come
from and how old is it"**. A semantic search that returns a confident sentence with no provenance is
worse than no search at all in a product whose claim is measured truth.

---

## 1. Pipeline

```
source (feed / API / URL / agent output)
   │
   ├─ fetch ............. through src/data transport (SSRF guard, 2 MiB cap, deadline)
   ├─ normalise ......... HTML → text, keep title, author, published_at, canonical URL
   ├─ verify ........... domain reliability tier, published_at present, canonical URL resolves
   ├─ dedupe ........... sha256(normalised text); same hash ⇒ same document, new fetch timestamp
   ├─ store ............ documents row + provenance (Postgres, authoritative)
   ├─ chunk ............ 800 tokens, 100 overlap, heading-aware
   ├─ embed ............ batched, retried, idempotent per (chunk_hash, model)
   └─ index ............ document_chunks row with `tsv` (generated) + `embedding vector(1536)`
```

**Ingestion is durable, not inline.** A 40-page crawl with embeddings is minutes of work; it runs as an
Inngest function (`thirdeye/knowledge.ingest`) with one `step.run` per document, so a crash resumes
rather than restarts.

---

## 2. Schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;   -- optional at runtime; code degrades if absent

CREATE TABLE IF NOT EXISTS documents (
  id             text PRIMARY KEY,                -- doc_<20 hex>
  user_id        text,                            -- null = platform corpus
  canonical_url  text NOT NULL,
  title          text NOT NULL DEFAULT '',
  author         text,
  publisher      text,                            -- registrable domain
  kind           text NOT NULL,                   -- article | docs | filing | thread | report | agent_output
  content_sha256 text NOT NULL,                   -- dedupe key over normalised text
  text           text NOT NULL,
  lang           text,
  published_at   timestamptz,                     -- provider's claim (untrusted until sanity-checked)
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  reliability    text NOT NULL,                   -- primary | aggregator | indexer | self_reported
  provenance     jsonb NOT NULL DEFAULT '{}',     -- the DataResult envelope from 04
  ttl_days       integer NOT NULL DEFAULT 180,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_sha256, COALESCE(user_id, 'platform'))
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id          text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal     integer NOT NULL,
  text        text NOT NULL,
  tokens      integer NOT NULL DEFAULT 0,
  chunk_sha256 text NOT NULL,
  embedding   vector(1536),                        -- null until embedded; keyword search still works
  embedding_model text,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  UNIQUE (document_id, chunk_sha256)
);

CREATE INDEX IF NOT EXISTS document_chunks_tsv_idx
  ON document_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS document_chunks_vec_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

Notes that matter operationally:

- **`embedding` is nullable on purpose.** Ingestion without an embedder still yields a searchable,
  keyword-indexed document. That is the feature that lets us ship before the embedding vendor decision
  in `02` §5 is made.
- **`hnsw` on a 0.25 CU Neon compute is a slow build.** Build the index on a branch first, measure, and
  keep `ef_construction` at 64 until recall is measured — a bigger graph is not free.
- **`tsv` is `GENERATED ... STORED`**, so it is maintained by Postgres and cannot drift from `text`.
- PGlite (used by every test) needs the vector extension registered explicitly when the database is
  created; the code must treat "extension absent" as a supported state, not an error.

---

## 3. Chunking

- **800 tokens per chunk, 100 token overlap**, split on headings/sentence boundaries where possible.
  800 keeps a chunk inside a retrieval budget of 4–6 chunks while carrying enough context to be useful.
- Chunk id and `chunk_sha256` are content-derived, so re-ingesting an edited page only re-embeds the
  chunks that changed. That is the whole reason ingestion is affordable.
- Every chunk keeps `ordinal`, so a retrieved passage can be expanded to its neighbours for context
  without a second search.

---

## 4. Search

Hybrid, in one round trip, because doing it in two and merging in Node loses the ranking discipline:

```sql
WITH q AS (
  SELECT $1::vector AS emb,
         websearch_to_tsquery('english', $2) AS tsq
)
SELECT c.id,
       c.document_id,
       c.ordinal,
       c.text,
       d.canonical_url,
       d.title,
       d.publisher,
       d.reliability,
       d.published_at,
       d.fetched_at,
       1 - (c.embedding <=> q.emb)                                  AS vector_score,
       ts_rank_cd(c.tsv, q.tsq)                                     AS keyword_score,
       -- 0.7/0.3 is a starting weight, not a finding: tune against a labelled query set.
       (0.7 * COALESCE(1 - (c.embedding <=> q.emb), 0)
      + 0.3 * LEAST(COALESCE(ts_rank_cd(c.tsv, q.tsq), 0), 1))      AS score
FROM document_chunks c
JOIN documents d ON d.id = c.document_id
CROSS JOIN q
WHERE (q.emb IS NULL OR c.embedding IS NOT NULL)
  AND (q.emb IS NOT NULL OR c.tsv @@ q.tsq)
ORDER BY score DESC
LIMIT $3;
```

When the extension or the embedder is unavailable, the same function drops the vector branch and runs
`ts_rank_cd` alone. Same signature, same provenance fields, lower quality — and it says so in the
result (`retrieval: 'keyword' | 'hybrid'`), because a caller deciding whether to trust a passage needs
to know which mode produced it.

**Freshness is part of ranking, not a filter applied afterwards.** A 3-year-old article about a
protocol's TVL is not equally useful to a 3-hour-old one. The retrieval tool accepts
`requireFreshDays` and the caller may weight recency; the default is to surface `fetched_at` and let
the consumer decide.

---

## 5. Source verification and reliability

Every document gets a `reliability` tier, assigned mechanically from the publisher, never from the
content:

| Tier | Examples | What it is allowed to support |
|---|---|---|
| `primary` | official docs, protocol repos, on-chain data, filed documents | a factual claim |
| `aggregator` | established data aggregators, major outlets with named authors | a factual claim when corroborated |
| `indexer` | block explorers, DEX indexers | addresses, transactions, pools |
| `self_reported` | project blogs, social posts, press releases | a claim **about** the project, never a fact about the world |

Verification rules enforced at ingestion:

- `canonical_url` must resolve through `ssrf.ts` and belong to the declared `publisher` domain; a
  redirect to another domain demotes the document rather than silently retargeting it.
- `published_at` in the future or before 2009 (pre-Bitcoin) is dropped, not clamped — a provider's
  timestamp is a claim, and a `self_reported` document claiming 2027 is a signal about the source.
- Identical `content_sha256` from a different publisher keeps the earliest `fetched_at` and records the
  duplicate in `provenance` rather than creating a second document.
- Anything entering a **public** surface needs two independent `primary`/`aggregator` sources. That is
  the same rule Sam already applies to pricing claims, moved from memory into a check.

---

## 6. Deduplication and retention

- **Dedupe** is `content_sha256` over normalised text (whitespace collapsed, boilerplate stripped, URLs
  canonicalised). Same article syndicated on three sites is one document with three provenance entries.
- **Retention**: `ttl_days` defaults to 180. A daily job deletes expired documents and their chunks;
  embeddings go with them. Financial and audit records are *never* in this table, so nothing here is
  subject to the ledger's retention rules.
- **Embedding storage is the expensive part.** At 1536 dimensions: ~6 KB raw per chunk, ~8–10 KB with
  HNSW overhead. A 100 k-chunk corpus is therefore 0.6–1 GB — close to the Neon 1 GB free ceiling.
  Decisions that follow from that number: cap the platform corpus at 50 k chunks by default, prefer
  smaller local embeddings when they become available, and never embed a document we would not cite.

---

## 7. Agent knowledge reuse

One new tool, exposed to agents exactly like `repo_read` is today (allowlisted, bounded, refusing
secret-shaped input):

```ts
knowledge_search({
  query: string,
  k?: number,              // default 5, max 10
  requireFreshDays?: number,
  minReliability?: 'primary' | 'aggregator'
})
```

Returns, per passage: `chunk_id`, `document_id`, `text` (≤1,200 chars), `canonical_url`, `title`,
`publisher`, `reliability`, `published_at`, `fetched_at`, `retrieval` mode, `score`.

Rules the implementation enforces:

- **Retrieved text is data, never instruction.** It cannot add a tool, raise a budget, change a policy
  or authorise a write. A document that says "ignore previous instructions" is a document that gets
  stored and quoted, not obeyed. This is the single most important sentence in this file.
- **URLs inside retrieved text are not auto-fetched.** Anything the agent then chooses to fetch goes
  through the same `ssrf.ts` guard as any other egress.
- **A claim needs a citation.** If an agent's output contains a factual claim sourced from retrieval,
  the citation (`document_id` + `canonical_url` + `fetched_at`) is attached to the artifact metadata,
  so the existing audit trail can re-check it later.
- **Budget.** Retrieval costs nothing at the vendor, but stuffing 10 passages into a prompt costs
  tokens on the paid path; the tool caps at 10 passages and 6 k characters total.

---

## 8. The embedding decision (open)

| Option | Cost | Pros | Cons |
|---|---|---|---|
| OpenAI `text-embedding-3-small` via BYOK | list price around **$0.02 per 1 M tokens** (confirm before quoting) | cheap, 1536 dims, one call | a vendor receives our document text; needs a funded key; a second provider relationship for a non-financial need |
| Local model behind a Cloudflare Worker | compute only (Workers AI billing) | no text leaves our stack | 10 ms CPU is not enough; needs Workers AI or a container; new moving part |
| **Defer embeddings; ship keyword + hybrid-ready schema** | **$0** | unblocks ingestion and retrieval today; schema already accepts vectors | recall on paraphrased queries is worse |

**Recommendation: defer, and ship §2–§4 without vectors.** The schema, the chunker, the retention job
and `knowledge_search` all work in keyword mode, so the corpus starts accumulating now and the embedder
becomes a backfill (`embedding IS NULL` rows) rather than a rewrite.
