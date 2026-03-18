# Graph Augmentation Evidence

Date: 2026-03-17
Status: Fixed research dossier for the graph PRD

This file freezes the primary-source technical facts used to refine [12-graph-augmentation-prd.md](/Users/luchoh/Dev/OB1/docs/12-graph-augmentation-prd.md#L1).

It is not the PRD. It is the evidence pack the PRD should stay consistent with.

## Source Set

- Neo4j Desktop:
  - https://neo4j.com/docs/desktop-manual/current/
  - https://neo4j.com/docs/desktop-manual/current/installation/
- Neo4j database administration:
  - https://neo4j.com/docs/operations-manual/current/database-administration/
- Neo4j vector indexes:
  - https://neo4j.com/docs/cypher-manual/current/indexes/semantic-indexes/vector-indexes/
- Neo4j vector memory guidance:
  - https://neo4j.com/docs/operations-manual/current/performance/vector-index-memory-configuration/
- Neo4j GraphRAG for Python:
  - https://neo4j.com/docs/neo4j-graphrag-python/current/
- pgvector official README:
  - https://github.com/pgvector/pgvector

## Verified Facts

### 1. Neo4j Desktop on this machine includes Enterprise capabilities

Official Neo4j Desktop docs state:

- Desktop includes a Developer edition license
- that license offers all Enterprise Edition capabilities
- usage is limited to an individual person on a single machine
- multi-machine features such as clustering are not supported

Operational implication:

- for this repo, multiple databases are a real available capability
- we can use one production graph database and one staging graph database on the same machine
- we should not design around clustering or distributed Neo4j behavior

### 2. Multiple databases are real, but transactions do not span them

Official database-administration docs state:

- Neo4j DBMS can manage multiple databases
- Enterprise Edition can have any number of standard databases
- each standard database contains a single graph
- a transaction cannot span across multiple databases

Operational implication:

- per-environment graph isolation is feasible
- synchronous write flows across multiple Neo4j databases are not
- graph projection should stay asynchronous and rebuildable

### 3. Neo4j has native vector indexes for nodes and relationships

Official vector-index docs state:

- Neo4j vector indexes are powered by Apache Lucene
- vector indexes can target nodes or relationships
- they support approximate nearest-neighbor search
- newer Neo4j versions support multi-label or multi-relationship-type vector indexes and additional properties for filtering

Operational implication:

- Neo4j can technically store vectors for graph-native retrieval
- this is a real design option, not a hypothetical future feature
- but it introduces a second vector store if we also keep pgvector canonical

### 4. Neo4j vector indexes have a real memory cost outside page cache

Official memory docs state:

- Lucene-backed vector indexes are cached by the operating system filesystem cache
- this is separate from Neo4j page cache
- memory planning must include heap, page cache, OS filesystem cache, and other OS memory
- vector footprint can become large quickly at realistic dimensions and counts

Operational implication:

- adding Neo4j vectors in v1 is not free just because the service already exists
- this is a real operational tax in addition to pgvector
- if Postgres already owns the canonical vectors, duplicating them in Neo4j should need a strong product justification

### 5. Neo4j has an official first-party GraphRAG package

Official GraphRAG docs state:

- `neo4j-graphrag` is the official Neo4j GraphRAG package for Python
- it includes retrievers and knowledge-graph builder pipeline support
- it also supports external retrievers for Weaviate, Pinecone, and Qdrant

Operational implication:

- Neo4j now has a serious official GenAI integration surface
- we can use it later as an implementation reference
- but the existence of the package does not by itself mean OB1 should adopt Neo4j-native vectors or a full GraphRAG architecture in v1

### 6. pgvector already covers the canonical vector role well

Official pgvector docs state:

- exact nearest-neighbor search is the default behavior
- HNSW indexes are supported
- filtering is supported through normal PostgreSQL indexes plus pgvector patterns
- hybrid search with PostgreSQL full-text search is supported
- iterative index scans improve filtered ANN behavior starting with pgvector 0.8.0

Operational implication:

- the current Postgres + pgvector design is not missing basic vector capability
- it already supports exact search, ANN, filtering, and hybrid search in the canonical database
- that strengthens the case for keeping vector truth in PostgreSQL and using Neo4j for relationships first

## Design Consequences

### Recommended v1 graph stance

- Keep PostgreSQL + pgvector as canonical for vectors and memory rows.
- Use Neo4j as a derived relationship layer first.
- Use one production graph database plus one staging graph database if we need safe projection experiments.
- Do not create per-source or per-import graph databases by default.

### Recommended v1 rejection

- Do not duplicate canonical embeddings into Neo4j in v1 unless graph-assisted retrieval proves impossible or clearly inferior without graph-native vectors.

Reason:

- pgvector already covers the canonical vector role
- Neo4j vector indexes are approximate
- Neo4j vector indexes add real OS-memory cost
- dual vector truth complicates sync and evaluation

### Recommended role for official Neo4j GraphRAG

- treat `neo4j-graphrag` as an implementation reference and later toolset
- do not let the existence of the package force OB1 into full GraphRAG architecture in v1

### Recommended first shipping graph

- provenance-first
- async projector
- one production graph DB
- optional staging graph DB
- graph-assisted retrieval only after side-by-side evaluation against vector-only answering
